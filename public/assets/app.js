import { createBackend, todayISO } from './backend.js';
import { promptPayPayload } from './promptpay.js';

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baht = (n) => `฿${Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
const hhmm = (t) => String(t || '').slice(0, 5);
const TH_DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const TH_DOW_FULL = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const parts = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };
const thDate = (iso) => { const p = parts(iso); return `${TH_DOW[p.dow]} ${p.d} ${TH_MON[p.m - 1]} ${p.y + 543}`; };
const thDateShort = (iso) => { const p = parts(iso); return `${TH_DOW[p.dow]} ${p.d} ${TH_MON[p.m - 1]}`; };
const SERVICE_ICON = { 1: '🙏', 2: '🦶', 3: '💧', 4: '🌿', 5: '💻', 6: '🌼' };
const PRESSURE = { soft: 'เบา', medium: 'กลาง', strong: 'หนัก' };
const STATUS = {
  pending_payment: 'รอชำระเงิน', awaiting_review: 'รอร้านตรวจสลิป', confirmed: 'ยืนยันแล้ว',
  checked_in: 'เช็คอินแล้ว', completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก', expired: 'หมดเวลาชำระ', no_show: 'ไม่มาตามนัด',
};
const ACTIVE = ['pending_payment', 'awaiting_review', 'confirmed', 'checked_in'];

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function sheet(html) {
  const s = $('#sheet');
  if (!html) { s.hidden = true; return; }
  s.querySelector('.sheet-card').innerHTML = html;
  s.hidden = false;
}
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') sheet(null); });

function confirmSheet(title, body, okLabel = 'ยืนยัน', danger = false) {
  return new Promise((resolve) => {
    sheet(`<h2>${esc(title)}</h2><p class="muted mt8">${body}</p>
      <div class="btn-row mt16"><button class="btn ghost" data-r="0">ไม่ใช่</button>
      <button class="btn ${danger ? 'danger' : ''}" data-r="1">${esc(okLabel)}</button></div>`);
    $('#sheet .sheet-card').onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      sheet(null); resolve(b.dataset.r === '1');
    };
  });
}

// ---------------------------------------------------------------------
// state
// ---------------------------------------------------------------------
const S = {
  be: null,
  profile: null,
  cat: null,
  tab: 'home',
  step: 1,
  draft: { serviceId: null, optionId: null, guests: 1, date: null, time: null, therapistId: null, name: '', phone: '', pressure: 'medium', note: '' },
  slots: null,
  slotsKey: '',
  current: null,     // การจองที่กำลังชำระเงิน / เพิ่งจอง
  slipData: null,
  mine: null,
  mineFilter: 'upcoming',
  busy: false,
};

const option = (id = S.draft.optionId) => S.cat?.services.flatMap(s => s.service_options).find(o => o.id === id);
const service = (id = S.draft.serviceId) => S.cat?.services.find(s => s.id === id);
const therapist = (id) => S.cat?.therapists.find(t => t.id === id);
const activeOptions = (s) => (s.service_options || []).filter(o => o.active !== false).sort((a, b) => a.duration_min - b.duration_min);

function dueFor(price, guests) {
  const st = S.cat.settings;
  if (st.payment_mode === 'none') return 0;
  if (st.payment_mode === 'deposit') return Math.min(Number(st.deposit_per_guest), Number(price)) * guests;
  return Number(price) * guests;
}

function isOpenNow() {
  const st = S.cat.settings;
  const d = new Date(Date.now() + 7 * 3600e3);
  const now = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const closed = S.cat.holidays.some(h => h.holiday_date === todayISO());
  return !closed && now >= hhmm(st.open_time) && now < hhmm(st.close_time);
}

function bookableDates() {
  const st = S.cat.settings;
  const holidays = new Set(S.cat.holidays.map(h => h.holiday_date));
  return Array.from({ length: st.max_days_ahead + 1 }, (_, i) => todayISO(i)).map(iso => ({ iso, closed: holidays.has(iso) }));
}

// ---------------------------------------------------------------------
// render
// ---------------------------------------------------------------------
function setTab(tab, { push = true } = {}) {
  S.tab = tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (push) history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
  render();
  window.scrollTo({ top: 0 });
  if (tab === 'mine') loadMine();
}

function render() {
  const view = $('#view');
  const cta = $('#cta-bar');
  cta.hidden = true; document.body.classList.remove('has-cta');
  if (!S.cat) { view.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'; return; }
  const fn = { home: renderHome, book: renderBook, mine: renderMine, shop: renderShop }[S.tab] || renderHome;
  view.innerHTML = fn();
  afterRender();
}

function showCta(infoHtml, label, action, disabled = false) {
  const cta = $('#cta-bar');
  cta.innerHTML = `<div class="info">${infoHtml}</div><button class="btn" data-action="${action}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
  cta.hidden = false; document.body.classList.add('has-cta');
}

// ---------- หน้าแรก ----------
function renderHome() {
  const st = S.cat.settings;
  const open = isOpenNow();
  const upcoming = (S.mine?.bookings || []).filter(b => ACTIVE.includes(b.status) && `${b.date} ${b.time}` >= `${todayISO()} 00:00`)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
  return `
    <section class="hero">
      <h1>สวัสดีค่ะ${S.profile?.name ? ` คุณ${esc(S.profile.name)}` : ''}</h1>
      <p>${esc(st.announcement || 'ผ่อนคลายกับการนวดเพื่อสุขภาพ จองคิวล่วงหน้าได้ง่าย ๆ ผ่าน LINE')}</p>
      <div class="hero-meta">
        <span><i class="dot ${open ? '' : 'closed'}"></i>${open ? 'เปิดอยู่' : 'ปิดอยู่'} · ${hhmm(st.open_time)}–${hhmm(st.close_time)} น.</span>
        <span>🛏️ 15 เตียง</span>
      </div>
      <button class="btn" data-action="start-book">จองคิวนวด</button>
    </section>

    ${upcoming ? `<section>
      <div class="section-title"><h2>นัดถัดไปของคุณ</h2><button class="link" data-tab-go="mine">ดูทั้งหมด</button></div>
      ${bookingCard(upcoming)}
    </section>` : ''}

    ${S.cat.banners.length ? `<section><div class="banners">${S.cat.banners.map(b => `
      <div class="banner"><b>${esc(b.title)}</b><span>${esc(b.body || '')}</span></div>`).join('')}</div></section>` : ''}

    <section>
      <div class="section-title"><h2>บริการของเรา</h2></div>
      ${S.cat.services.filter(s => s.active !== false).map(s => serviceCard(s)).join('')}
    </section>`;
}

function serviceCard(s, selected = false) {
  const opts = activeOptions(s);
  const min = Math.min(...opts.map(o => Number(o.price)));
  const icon = s.image_url ? `<img src="${esc(s.image_url)}" alt="">` : (SERVICE_ICON[s.id] || '💆');
  return `<button class="service ${selected ? 'selected' : ''}" data-action="pick-service" data-id="${s.id}">
    <div class="service-icon">${icon}</div>
    <div class="service-body">
      <div class="row-between"><div class="service-name">${esc(s.name)}</div><div class="service-price">เริ่ม ${baht(min)}</div></div>
      <div class="service-desc">${esc(s.description || '')}</div>
      <div class="small muted">${opts.map(o => `${o.duration_min}`).join(' / ')} นาที</div>
    </div>
  </button>`;
}

// ---------- จองคิว ----------
function stepsBar() {
  return `<div class="steps">${[1, 2, 3, 4].map(i => `<div class="${i <= S.step ? 'on' : ''}"></div>`).join('')}</div>`;
}

function renderBook() {
  if (S.step === 5) return renderDone();
  if (S.step === 4) return renderPay();
  if (S.step === 3) return renderInfo();
  if (S.step === 2) return renderWhen();
  return renderService();
}

function renderService() {
  const d = S.draft;
  const s = service();
  const opt = option();
  showCta(
    opt ? `${esc(s.name)}<b>${opt.duration_min} นาที · ${baht(opt.price)}</b>` : 'ขั้นตอนที่ 1 จาก 4<b>เลือกบริการ</b>',
    'ถัดไป', 'go-when', !opt,
  );
  return `${stepsBar()}
    <div class="step-label">ขั้นตอนที่ 1</div>
    <h2 style="margin-bottom:12px">เลือกบริการและระยะเวลา</h2>
    ${S.cat.services.filter(x => x.active !== false).map(x => `
      ${serviceCard(x, x.id === d.serviceId)}
      ${x.id === d.serviceId ? `<div class="durations" style="margin:10px 0 16px">${activeOptions(x).map(o => `
        <button class="chip ${o.id === d.optionId ? 'selected' : ''}" data-action="pick-option" data-id="${o.id}">
          ${o.duration_min} นาที<small>${baht(o.price)}</small></button>`).join('')}</div>` : ''}
    `).join('')}`;
}

function renderWhen() {
  const d = S.draft;
  const st = S.cat.settings;
  const opt = option();
  const dates = bookableDates();
  const slots = S.slots;
  const ths = S.cat.therapists;
  showCta(
    d.time ? `${thDateShort(d.date)} · ${d.guests} ท่าน<b>${d.time} – ${endTime(d.time, opt.duration_min)} น.</b>` : `${esc(service().name)} ${opt.duration_min} นาที<b>เลือกวันและเวลา</b>`,
    'ถัดไป', 'go-info', !d.time,
  );
  return `${stepsBar()}
    <div class="step-label">ขั้นตอนที่ 2</div>
    <h2 style="margin-bottom:14px">เลือกวันและเวลา</h2>

    <div class="card row-between">
      <div><div style="font-weight:500">จำนวนผู้ใช้บริการ</div><div class="small muted">มาด้วยกัน นวดพร้อมกัน</div></div>
      <div class="counter">
        <button data-action="guests" data-d="-1" ${d.guests <= 1 ? 'disabled' : ''} aria-label="ลด">−</button>
        <span>${d.guests}</span>
        <button data-action="guests" data-d="1" ${d.guests >= st.max_guests ? 'disabled' : ''} aria-label="เพิ่ม">+</button>
      </div>
    </div>

    <section>
      <div class="section-title"><h3>วันที่</h3><span class="small muted">จองล่วงหน้าได้ ${st.max_days_ahead} วัน</span></div>
      <div class="dates">${dates.map(x => {
        const p = parts(x.iso);
        return `<button class="date-chip ${x.iso === d.date ? 'selected' : ''}" data-action="pick-date" data-iso="${x.iso}" ${x.closed ? 'disabled' : ''}>
          <span class="dow">${x.iso === todayISO() ? 'วันนี้' : TH_DOW[p.dow]}</span><span class="day">${p.d}</span><span class="mon">${x.closed ? 'ปิด' : TH_MON[p.m - 1]}</span></button>`;
      }).join('')}</div>
    </section>

    <section>
      <div class="section-title"><h3>หมอนวด</h3><span class="small muted">ไม่ระบุ = ร้านจัดให้</span></div>
      <div class="therapists">
        <button class="th ${!d.therapistId ? 'selected' : ''}" data-action="pick-therapist" data-id=""><span class="av">✨</span>ไม่ระบุ</button>
        ${ths.filter(t => !d.date || !(t.days_off || []).includes(parts(d.date).dow)).map(t => `
          <button class="th ${d.therapistId === t.id ? 'selected' : ''}" data-action="pick-therapist" data-id="${t.id}">
            <span class="av">${t.photo_url ? `<img src="${esc(t.photo_url)}" alt="">` : (t.gender === 'male' ? '👨' : '👩')}</span>${esc(t.nickname)}</button>`).join('')}
      </div>
      ${d.therapistId ? `<p class="small muted mt8">ความถนัด: ${esc((therapist(d.therapistId)?.specialties || []).join(', ') || '-')}</p>` : ''}
    </section>

    <section>
      <div class="section-title"><h3>เวลา</h3>${d.date ? `<span class="small muted">${thDate(d.date)}</span>` : ''}</div>
      ${!d.date ? '<div class="empty">เลือกวันที่ก่อน</div>'
        : !slots ? '<div class="skeleton"></div>'
        : !slots.length ? '<div class="empty"><div class="big">🌙</div>ร้านปิดหรือไม่มีรอบในวันนี้</div>'
        : !slots.some(s => s.available) ? `<div class="empty"><div class="big">😴</div>คิวเต็มทั้งวันแล้ว ลองเลือกวันอื่น${d.therapistId ? 'หรือเปลี่ยนเป็น "ไม่ระบุ" หมอนวด' : ''}</div>`
        : `<div class="times">${slots.map(s => {
            const free = Math.min(s.beds_free, s.therapists_free);
            return `<button class="time ${s.slot_time === d.time ? 'selected' : ''} ${free <= 3 ? 'low' : ''}" data-action="pick-time" data-t="${s.slot_time}" ${s.available ? '' : 'disabled'}>
              ${s.slot_time}<small>${s.available ? (free <= 3 ? `เหลือ ${free}` : 'ว่าง') : 'เต็ม'}</small></button>`;
          }).join('')}</div>
          <div class="legend"><span>นวดเสร็จ ${d.time ? endTime(d.time, opt.duration_min) : '–'} น.</span><span>ร้านเปิด ${hhmm(st.open_time)}–${hhmm(st.close_time)}</span></div>`}
    </section>
    <div class="mt12"><button class="link" data-action="back">‹ ย้อนกลับ</button></div>`;
}

function endTime(t, dur) {
  const [h, m] = t.split(':').map(Number);
  const e = h * 60 + m + dur;
  return `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
}

function summaryHtml(b) {
  return `<div class="card summary"><dl>
    <dt>บริการ</dt><dd>${esc(b.service_name)}</dd>
    <dt>ระยะเวลา</dt><dd>${b.duration_min} นาที</dd>
    <dt>วันที่</dt><dd>${thDate(b.date)}</dd>
    <dt>เวลา</dt><dd>${b.time} – ${b.end_time} น.</dd>
    <dt>จำนวน</dt><dd>${b.guests} ท่าน</dd>
    ${b.therapist ? `<dt>หมอนวด</dt><dd>${esc(b.therapist)}</dd>` : ''}
  </dl>
  <div class="total"><span>ราคารวม</span><span>${baht(b.total_price)}</span></div>
  ${b.amount_due > 0 ? `<div class="row-between mt8 small"><span class="muted">${S.cat.settings.payment_mode === 'deposit' ? 'มัดจำโอนตอนนี้' : 'ชำระตอนนี้'}</span><b class="due">${baht(b.amount_due)}</b></div>
  ${S.cat.settings.payment_mode === 'deposit' ? `<div class="row-between small"><span class="muted">ชำระที่ร้าน</span><span>${baht(b.total_price - b.amount_due)}</span></div>` : ''}` : '<p class="small muted mt8">ชำระเงินที่ร้านหลังใช้บริการ</p>'}
  </div>`;
}

function renderInfo() {
  const d = S.draft;
  const opt = option();
  const total = Number(opt.price) * d.guests;
  const due = dueFor(opt.price, d.guests);
  showCta(`ราคารวม<b>${baht(total)}</b>`, due > 0 ? `ยืนยันและชำระ ${baht(due)}` : 'ยืนยันการจอง', 'submit', S.busy);
  return `${stepsBar()}
    <div class="step-label">ขั้นตอนที่ 3</div>
    <h2 style="margin-bottom:14px">ข้อมูลผู้จอง</h2>
    <form id="info-form" autocomplete="on" onsubmit="return false">
      <label class="field"><span>ชื่อผู้จอง</span><input class="input" name="name" value="${esc(d.name)}" placeholder="ชื่อ-นามสกุล หรือชื่อเล่น" maxlength="80" required></label>
      <label class="field"><span>เบอร์โทรศัพท์</span><input class="input" name="phone" value="${esc(d.phone)}" type="tel" inputmode="tel" placeholder="08x-xxx-xxxx" maxlength="13" required></label>
      <div class="field" style="margin-bottom:14px"><span class="small muted" style="display:block;margin-bottom:6px">น้ำหนักมือที่ชอบ</span>
        <div class="seg">${Object.entries(PRESSURE).map(([k, v]) => `<button type="button" class="${d.pressure === k ? 'selected' : ''}" data-action="pressure" data-v="${k}">${v}</button>`).join('')}</div>
      </div>
      <label class="field"><span>หมายเหตุถึงหมอนวด (ไม่บังคับ)</span><textarea class="input" name="note" maxlength="300" placeholder="เช่น ปวดคอ บ่า ไหล่ · ตั้งครรภ์ · เคยผ่าตัด · มีโรคประจำตัว">${esc(d.note)}</textarea></label>
    </form>
    ${summaryHtml({
      service_name: service().name, duration_min: opt.duration_min, date: d.date, time: d.time, end_time: endTime(d.time, opt.duration_min),
      guests: d.guests, therapist: d.therapistId ? therapist(d.therapistId)?.nickname : 'ร้านจัดให้', total_price: total, amount_due: due,
    })}
    <p class="small muted mt12">ยกเลิกเองได้ก่อนเวลานัด ${S.cat.settings.cancel_before_hours} ชั่วโมง${due > 0 ? ` · ต้องโอนและแนบสลิปภายใน ${S.cat.settings.hold_minutes} นาที ไม่เช่นนั้นคิวจะถูกปล่อย` : ''}</p>
    <div class="mt12"><button class="link" data-action="back">‹ ย้อนกลับ</button></div>`;
}

function renderPay() {
  const b = S.current;
  const st = S.cat.settings;
  let qr = '';
  if (st.promptpay_id && window.qrcode) {
    try {
      const q = window.qrcode(0, 'M');
      q.addData(promptPayPayload(st.promptpay_id, b.amount_due));
      q.make();
      qr = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch (e) { console.warn('promptpay qr failed', e); }
  }
  showCta(`ยอดโอน<b>${baht(b.amount_due)}</b>`, S.busy ? 'กำลังส่ง…' : 'ส่งสลิป', 'send-slip', !S.slipData || S.busy);
  return `${stepsBar()}
    <div class="step-label">ขั้นตอนที่ 4</div>
    <div class="row-between" style="margin-bottom:12px"><h2>ชำระเงิน</h2><span class="countdown" id="countdown">⏱ --:--</span></div>
    <div class="card">
      <div class="pay-amount"><div class="small muted">ยอดที่ต้องโอน · ${esc(b.code)}</div><div class="amt">${baht(b.amount_due)}</div></div>
      ${qr ? `<div class="qr-box mt12"><div class="pp-head">PromptPay · พร้อมเพย์</div>${qr}
        <div class="small muted center">สแกนด้วยแอปธนาคาร ยอดเงินถูกใส่ไว้แล้ว</div></div>` : ''}
      ${st.account_number ? `<div class="bank mt12"><div><div class="small muted">${esc(st.bank_name || '')}</div>
        <div class="acc">${esc(st.account_number)}</div><div class="small">${esc(st.account_name || '')}</div></div>
        <button class="btn soft" data-action="copy" data-v="${esc(String(st.account_number).replace(/\D/g, ''))}">คัดลอก</button></div>` : ''}
      ${!qr && !st.account_number ? '<p class="muted center">ร้านยังไม่ได้ตั้งค่าบัญชีรับเงิน กรุณาติดต่อร้าน</p>' : ''}
    </div>
    <section>
      <div class="section-title"><h3>แนบสลิปโอนเงิน</h3></div>
      <label class="upload" id="upload">
        <input type="file" accept="image/*" id="slip-input">
        ${S.slipData ? `<img src="${S.slipData}" alt="สลิป">` : '<span style="font-size:28px">🧾</span><span>แตะเพื่อเลือกรูปสลิป</span>'}
      </label>
    </section>
    <div class="mt16 center"><button class="link" data-action="cancel-current" style="color:var(--danger)">ยกเลิกการจองนี้</button></div>`;
}

function renderDone() {
  const b = S.current;
  const waiting = b.status === 'awaiting_review';
  return `<div class="success">
      <div class="check">${waiting ? '⏳' : '✓'}</div>
      <h2>${waiting ? 'ส่งสลิปเรียบร้อย' : 'จองคิวสำเร็จ'}</h2>
      <p class="muted mt8">${waiting ? 'ร้านจะตรวจสอบและยืนยันการจองทาง LINE' : 'ร้านส่งรายละเอียดการจองไปที่ LINE ของคุณแล้ว'}</p>
      <div class="code mt12">${esc(b.code)}</div>
    </div>
    ${summaryHtml({ ...b, therapist: (b.slots || []).map(s => s.therapist).filter(Boolean).join(', ') })}
    ${(b.slots || []).length ? `<p class="small muted mt8">เตียง: ${b.slots.map(s => esc(s.bed)).join(', ')} (อาจปรับตามหน้างาน)</p>` : ''}
    <div class="mt16" style="display:grid;gap:10px">
      ${S.be.lineOaUrl ? `<a class="btn line block" href="${esc(S.be.lineOaUrl)}">เปิดแชทกับร้าน</a>` : ''}
      <button class="btn ghost block" data-tab-go="mine">ดูการจองของฉัน</button>
      <button class="btn soft block" data-action="new-booking">จองเพิ่ม</button>
    </div>`;
}

// ---------- การจองของฉัน ----------
function bookingCard(b) {
  const canPay = b.status === 'pending_payment';
  const canCancel = ['pending_payment', 'awaiting_review', 'confirmed'].includes(b.status);
  const therapists = (b.slots || []).map(s => s.therapist).filter(Boolean).join(', ');
  return `<div class="card bk">
    <div class="bk-top">
      <div><div class="bk-when">${thDateShort(b.date)} · ${b.time} น.</div>
        <div class="bk-meta">${esc(b.service_name)} ${b.duration_min} นาที · ${b.guests} ท่าน${therapists ? ` · ${esc(therapists)}` : ''}</div>
        <div class="bk-meta">${esc(b.code)} · ${baht(b.total_price)}</div></div>
      <span class="pill ${b.status}">${STATUS[b.status] || b.status}</span>
    </div>
    ${canPay || canCancel ? `<div class="bk-actions">
      ${canPay ? `<button class="btn" data-action="resume-pay" data-id="${b.id}">ชำระเงิน</button>` : ''}
      ${canCancel ? `<button class="btn danger" data-action="cancel" data-id="${b.id}">ยกเลิก</button>` : ''}
    </div>` : ''}
  </div>`;
}

function renderMine() {
  if (!S.mine) return '<div class="skeleton"></div><div class="skeleton"></div>';
  const now = `${todayISO()} 00:00`;
  const list = S.mine.bookings || [];
  const upcoming = list.filter(b => ACTIVE.includes(b.status) && `${b.date} ${b.time}` >= now).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = list.filter(b => !upcoming.includes(b));
  const shown = S.mineFilter === 'upcoming' ? upcoming : past;
  return `<h2 style="margin-bottom:12px">การจองของฉัน</h2>
    <div class="seg" style="margin-bottom:14px">
      <button class="${S.mineFilter === 'upcoming' ? 'selected' : ''}" data-action="mine-filter" data-v="upcoming">กำลังจะมาถึง (${upcoming.length})</button>
      <button class="${S.mineFilter === 'past' ? 'selected' : ''}" data-action="mine-filter" data-v="past">ประวัติ (${past.length})</button>
    </div>
    ${shown.length ? shown.map(bookingCard).join('') : `<div class="empty"><div class="big">🗓️</div>${S.mineFilter === 'upcoming' ? 'ยังไม่มีนัดหมาย' : 'ยังไม่มีประวัติ'}
      ${S.mineFilter === 'upcoming' ? '<div class="mt12"><button class="btn" data-action="start-book">จองคิวนวด</button></div>' : ''}</div>`}
    ${S.mine.customer?.visits ? `<p class="center small muted mt16">คุณใช้บริการกับเราแล้ว ${S.mine.customer.visits} ครั้ง 💚</p>` : ''}`;
}

// ---------- ร้าน ----------
function renderShop() {
  const st = S.cat.settings;
  return `<section class="card">
      <h2>${esc(st.shop_name)}</h2>
      <p class="muted small">${esc(st.tagline || '')}</p>
      <div class="mt12">
        <div class="info-row"><span class="k">เวลาเปิด</span><span>ทุกวัน ${hhmm(st.open_time)} – ${hhmm(st.close_time)} น.</span></div>
        <div class="info-row"><span class="k">ที่อยู่</span><span>${esc(st.address || '-')}</span></div>
        ${st.phone ? `<div class="info-row"><span class="k">โทร</span><a href="tel:${esc(st.phone)}">${esc(st.phone)}</a></div>` : ''}
        <div class="info-row"><span class="k">จำนวนเตียง</span><span>15 เตียง</span></div>
        <div class="info-row"><span class="k">การจอง</span><span>ล่วงหน้าได้ ${st.max_days_ahead} วัน · สูงสุด ${st.max_guests} ท่าน/การจอง</span></div>
        <div class="info-row"><span class="k">ยกเลิก</span><span>ยกเลิกเองได้ก่อนนัด ${st.cancel_before_hours} ชม.</span></div>
      </div>
      <div class="btn-row mt16">
        ${st.map_url ? `<a class="btn ghost" href="${esc(st.map_url)}" target="_blank" rel="noopener">แผนที่</a>` : ''}
        ${st.phone ? `<a class="btn ghost" href="tel:${esc(st.phone)}">โทรหาร้าน</a>` : ''}
      </div>
    </section>
    <section>
      <div class="section-title"><h2>ราคา</h2></div>
      <div class="card">${S.cat.services.filter(s => s.active !== false).map(s => `
        <div class="info-row"><span style="flex:1">${esc(s.name)}</span><span class="small">${activeOptions(s).map(o => `${o.duration_min}′ ${baht(o.price)}`).join(' · ')}</span></div>`).join('')}
      </div>
    </section>
    <section>
      <div class="section-title"><h2>ทีมหมอนวด</h2></div>
      <div class="therapists">${S.cat.therapists.map(t => `<div class="th"><span class="av">${t.photo_url ? `<img src="${esc(t.photo_url)}" alt="">` : (t.gender === 'male' ? '👨' : '👩')}</span>${esc(t.nickname)}</div>`).join('')}</div>
    </section>`;
}

// ---------------------------------------------------------------------
// after render: bind inputs, timers
// ---------------------------------------------------------------------
function afterRender() {
  const form = $('#info-form');
  if (form) {
    form.addEventListener('input', (e) => { if (e.target.name) S.draft[e.target.name] = e.target.value; });
  }
  const input = $('#slip-input');
  if (input) input.addEventListener('change', onSlipPicked);
  startCountdown();
}

function startCountdown() {
  clearInterval(startCountdown._t);
  const el = $('#countdown');
  if (!el || !S.current?.hold_expires_at) { if (el) el.hidden = true; return; }
  const tick = () => {
    const ms = new Date(S.current.hold_expires_at) - Date.now();
    if (ms <= 0) {
      el.textContent = '⏱ หมดเวลา';
      clearInterval(startCountdown._t);
      return;
    }
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    el.textContent = `⏱ ชำระภายใน ${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  startCountdown._t = setInterval(tick, 1000);
}

async function onSlipPicked(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    S.slipData = await compressImage(file);
    render();
  } catch {
    toast('อ่านไฟล์รูปไม่ได้ ลองเลือกใหม่');
  }
}

function compressImage(file, max = 1400, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ---------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------
async function loadSlots() {
  const d = S.draft;
  const opt = option();
  if (!d.date || !opt) return;
  const key = [d.date, opt.duration_min, d.guests, d.therapistId].join('|');
  S.slotsKey = key; S.slots = null; render();
  try {
    const slots = await S.be.availability({ date: d.date, duration: opt.duration_min, guests: d.guests, zone: service().bed_zone, therapistId: d.therapistId });
    if (S.slotsKey !== key) return;
    S.slots = slots;
    if (d.time && !slots.find(s => s.slot_time === d.time && s.available)) d.time = null;
  } catch (e) {
    S.slots = []; toast(e.message);
  }
  if (S.tab === 'book' && S.step === 2) render();
}

async function loadMine() {
  try {
    S.mine = await S.be.myBookings();
    const c = S.mine.customer;
    S.draft.name ||= c?.full_name || S.profile?.name || '';
    S.draft.phone ||= c?.phone || '';
    if (c?.pressure) S.draft.pressure = c.pressure;
  } catch (e) {
    S.mine = S.mine || { bookings: [] };
    toast(e.message);
  }
  if (S.tab === 'mine' || S.tab === 'home') render();
}

// ---------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------
const actions = {
  'start-book'() { S.step = 1; setTab('book'); },
  'new-booking'() { S.step = 1; S.current = null; S.slipData = null; S.draft.time = null; setTab('book'); },
  'pick-service'(el) {
    const id = Number(el.dataset.id);
    if (S.tab !== 'book') { S.step = 1; setTab('book'); }
    if (S.draft.serviceId !== id) {
      S.draft.serviceId = id;
      const opts = activeOptions(service(id));
      S.draft.optionId = (opts.find(o => o.duration_min === 60) || opts[0])?.id ?? null;
      S.draft.time = null;
    }
    render();
  },
  'pick-option'(el) { S.draft.optionId = Number(el.dataset.id); S.draft.time = null; render(); },
  'go-when'() {
    S.step = 2;
    if (!S.draft.date) {
      // ถ้าวันนี้ใกล้ปิดร้านแล้ว เริ่มที่วันพรุ่งนี้
      const st = S.cat.settings;
      const n = new Date(Date.now() + 7 * 3600e3);
      const nowMin = n.getUTCHours() * 60 + n.getUTCMinutes();
      const [ch, cm] = hhmm(st.close_time).split(':').map(Number);
      const lateToday = nowMin + Number(st.min_lead_minutes) + option().duration_min > ch * 60 + cm;
      S.draft.date = bookableDates().find(d => !d.closed && !(lateToday && d.iso === todayISO()))?.iso;
    }
    render(); window.scrollTo({ top: 0 }); loadSlots();
  },
  guests(el) {
    S.draft.guests = Math.max(1, Math.min(S.cat.settings.max_guests, S.draft.guests + Number(el.dataset.d)));
    loadSlots();
  },
  'pick-date'(el) {
    S.draft.date = el.dataset.iso;
    const t = therapist(S.draft.therapistId);
    if (t && (t.days_off || []).includes(parts(S.draft.date).dow)) { S.draft.therapistId = null; toast(`${t.nickname} หยุดวัน${TH_DOW_FULL[parts(S.draft.date).dow]}`); }
    loadSlots();
  },
  'pick-therapist'(el) { S.draft.therapistId = el.dataset.id || null; loadSlots(); },
  'pick-time'(el) { S.draft.time = el.dataset.t; render(); },
  'go-info'() { S.step = 3; render(); window.scrollTo({ top: 0 }); },
  back() { S.step = Math.max(1, S.step - 1); render(); if (S.step === 2) loadSlots(); },
  pressure(el) { S.draft.pressure = el.dataset.v; render(); },

  async submit() {
    const d = S.draft;
    if (!d.name.trim()) return toast('กรุณากรอกชื่อ');
    if (d.phone.replace(/\D/g, '').length < 9) return toast('กรุณากรอกเบอร์โทรให้ถูกต้อง');
    S.busy = true; render();
    try {
      const b = await S.be.book({
        optionId: d.optionId, guests: d.guests, date: d.date, time: d.time, therapistId: d.therapistId,
        name: d.name.trim(), phone: d.phone, pressure: d.pressure, note: d.note.trim(),
      });
      S.current = b; S.slipData = null;
      S.step = b.status === 'pending_payment' ? 4 : 5;
      S.mine = null; loadMine();
    } catch (e) {
      toast(e.message, 3500);
      if (e.status === 409 || /เต็ม|ไม่ว่าง/.test(e.message)) { S.step = 2; S.draft.time = null; loadSlots(); }
    } finally {
      S.busy = false; render(); window.scrollTo({ top: 0 });
    }
  },

  async 'send-slip'() {
    if (!S.slipData || S.busy) return;
    S.busy = true; render();
    try {
      S.current = await S.be.uploadSlip(S.current.id, S.slipData);
      S.step = 5; S.slipData = null;
      loadMine();
    } catch (e) {
      toast(e.message, 3500);
    } finally {
      S.busy = false; render(); window.scrollTo({ top: 0 });
    }
  },

  'resume-pay'(el) {
    const b = S.mine.bookings.find(x => x.id === el.dataset.id);
    if (!b) return;
    S.current = b; S.slipData = null; S.step = 4; setTab('book');
  },

  async cancel(el) {
    const b = S.mine.bookings.find(x => x.id === el.dataset.id);
    if (!b) return;
    const ok = await confirmSheet('ยกเลิกการจอง?', `${esc(b.service_name)} · ${thDate(b.date)} ${b.time} น.${b.has_slip ? '<br>หากโอนมัดจำแล้ว ร้านจะติดต่อเรื่องการคืนเงิน' : ''}`, 'ยกเลิกการจอง', true);
    if (!ok) return;
    try { await S.be.cancel(b.id); toast('ยกเลิกแล้ว'); } catch (e) { toast(e.message, 3500); }
    loadMine();
  },

  async 'cancel-current'() {
    const ok = await confirmSheet('ยกเลิกการจองนี้?', 'คิวจะถูกปล่อยให้ลูกค้าท่านอื่น', 'ยกเลิกการจอง', true);
    if (!ok) return;
    try { await S.be.cancel(S.current.id); } catch (e) { toast(e.message); }
    S.current = null; S.step = 2; S.draft.time = null; loadMine(); render(); loadSlots();
  },

  'mine-filter'(el) { S.mineFilter = el.dataset.v; render(); },

  async copy(el) {
    try { await navigator.clipboard.writeText(el.dataset.v); toast('คัดลอกเลขบัญชีแล้ว'); } catch { toast(el.dataset.v); }
  },
};

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn && tabBtn.closest('.tabbar')) {
    if (tabBtn.dataset.tab === 'book' && S.step === 5) { S.step = 1; S.current = null; }
    return setTab(tabBtn.dataset.tab);
  }
  const go = e.target.closest('[data-tab-go]');
  if (go) { if (go.dataset.tabGo === 'book') S.step = 1; return setTab(go.dataset.tabGo); }
  const a = e.target.closest('[data-action]');
  if (a && actions[a.dataset.action]) { e.preventDefault(); actions[a.dataset.action](a); }
});

// ---------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------
(async function boot() {
  render();
  try {
    S.be = await createBackend();
    $('#demo-banner').hidden = !S.be.demo;
    S.profile = await S.be.login();
    if (S.profile?.picture) $('#user-chip').innerHTML = `<img src="${esc(S.profile.picture)}" alt="">`;
    S.cat = await S.be.catalog();
    S.cat.therapists = S.cat.therapists || [];
    S.cat.services.sort((a, b) => a.sort - b.sort);
    document.querySelectorAll('[data-bind]').forEach(el => { const v = S.cat.settings[el.dataset.bind]; if (v) el.textContent = v; });
    if (S.cat.settings.shop_name) document.title = `${S.cat.settings.shop_name} · จองคิวนวด`;
    const want = (location.hash.slice(1) || new URLSearchParams(location.search).get('tab') || 'home');
    setTab(['home', 'book', 'mine', 'shop'].includes(want) ? want : 'home', { push: false });
    if (S.tab !== 'mine') loadMine();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="empty"><div class="big">⚠️</div>โหลดข้อมูลไม่สำเร็จ<br><span class="small">${esc(e.message)}</span>
      <div class="mt12"><button class="btn" onclick="location.reload()">ลองใหม่</button></div></div>`;
  }
})();
