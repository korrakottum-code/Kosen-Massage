// หน้าหลังร้าน: ตารางเตียง 15 เตียง, ตรวจสลิป, เปลี่ยนสถานะ, รับ walk-in
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baht = (n) => `฿${Number(n || 0).toLocaleString('th-TH')}`;
const hhmm = (t) => String(t || '').slice(0, 5);
const toMin = (t) => { const [h, m] = hhmm(t).split(':').map(Number); return h * 60 + m; };
const todayISO = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const STATUS = {
  pending_payment: 'รอชำระ', awaiting_review: 'รอตรวจสลิป', confirmed: 'ยืนยันแล้ว', checked_in: 'กำลังนวด',
  completed: 'เสร็จสิ้น', cancelled: 'ยกเลิก', expired: 'หมดเวลาชำระ', no_show: 'ไม่มา',
};
const SOURCE = { liff: 'LINE', walk_in: 'Walk-in', phone: 'โทร' };
const PRESSURE = { soft: 'เบา', medium: 'กลาง', strong: 'หนัก' };
const LIVE = ['pending_payment', 'awaiting_review', 'confirmed', 'checked_in', 'completed'];

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function sheet(html) {
  const s = $('#sheet');
  if (!html) { s.hidden = true; return; }
  s.querySelector('.sheet-card').innerHTML = html; s.hidden = false;
}
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') sheet(null); });

const A = { sb: null, session: null, view: 'timeline', day: todayISO(), bookings: [], pending: [], ref: null };

const thName = (id) => A.ref.therapists.find(t => t.id === id)?.nickname || '';

// ---------------------------------------------------------------------
async function boot() {
  const cfg = await fetch('/api/config').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!cfg?.supabaseUrl) {
    document.body.innerHTML = '<div class="empty"><div class="big">⚙️</div>ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_ANON_KEY บน Vercel<br>ดูขั้นตอนใน README</div>';
    return;
  }
  A.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await A.sb.auth.getSession();
  A.session = data.session;
  A.sb.auth.onAuthStateChange((_e, s) => { A.session = s; });
  if (!A.session) return showLogin();
  await start();
}

function showLogin(msg = '') {
  $('#shell').hidden = true; $('#login').hidden = false; $('#login-msg').textContent = msg;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-msg').textContent = 'กำลังเข้าสู่ระบบ…';
  const { data, error } = await A.sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
  if (error) return showLogin('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  A.session = data.session;
  await start();
});

async function start() {
  const { data: isStaff } = await A.sb.rpc('is_staff');
  if (!isStaff) { await A.sb.auth.signOut(); return showLogin('บัญชีนี้ยังไม่ได้เป็นพนักงาน (เพิ่มในตาราง staff)'); }
  const [settings, beds, therapists, services] = await Promise.all([
    A.sb.from('shop_settings').select('*').eq('id', 1).single(),
    A.sb.from('beds').select('*').eq('active', true).order('sort'),
    A.sb.from('therapists').select('*').eq('active', true).order('sort'),
    A.sb.from('services').select('*, service_options(*)').eq('active', true).order('sort'),
  ]);
  A.ref = { settings: settings.data, beds: beds.data || [], therapists: therapists.data || [], services: services.data || [] };
  $('#who').textContent = A.session.user.email;
  $('#login').hidden = true; $('#shell').hidden = false;
  $('#day').value = A.day;
  await refresh();
  setInterval(refresh, 30000);
}

async function refresh() {
  const [day, pending] = await Promise.all([A.sb.rpc('admin_day', { p_date: A.day }), A.sb.rpc('admin_pending')]);
  if (day.error) { toast(day.error.message); return; }
  A.bookings = day.data || [];
  A.pending = pending.data || [];
  const c = $('#review-count'); c.hidden = !A.pending.length; c.textContent = A.pending.length;
  renderStats();
  render();
}

function renderStats() {
  const live = A.bookings.filter(b => LIVE.includes(b.status));
  const guests = live.reduce((s, b) => s + b.guests, 0);
  const revenue = live.reduce((s, b) => s + Number(b.total_price), 0);
  const bedMin = live.reduce((s, b) => s + b.duration_min * b.guests, 0);
  const cap = A.ref.beds.length * (toMin(A.ref.settings.close_time) - toMin(A.ref.settings.open_time));
  $('#stats').innerHTML = `<span>การจอง <b>${live.length}</b></span><span>ลูกค้า <b>${guests}</b> ท่าน</span>
    <span>ใช้เตียง <b>${cap ? Math.round(bedMin / cap * 100) : 0}%</b></span><span>ยอดคาดการณ์ <b>${baht(revenue)}</b></span>`;
}

function render() {
  document.querySelectorAll('.a-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === A.view));
  const v = $('#a-view');
  if (A.view === 'review') v.innerHTML = renderReview();
  else if (A.view === 'list') v.innerHTML = renderList();
  else v.innerHTML = renderTimeline();
  if (A.view === 'review') loadSlipImages();
}

// ---------- ตารางเตียง ----------
function renderTimeline() {
  const open = toMin(A.ref.settings.open_time), close = toMin(A.ref.settings.close_time);
  const span = close - open;
  const pct = (m) => `${((m - open) / span) * 100}%`;
  const hours = [];
  for (let m = Math.ceil(open / 60) * 60; m < close; m += 60) hours.push(m);
  const buffer = A.ref.settings.buffer_minutes || 0;

  const slotsByBed = new Map(A.ref.beds.map(b => [b.id, []]));
  for (const b of A.bookings.filter(x => LIVE.includes(x.status))) {
    for (const s of b.slots) slotsByBed.get(s.bed_id)?.push({ b, s });
  }
  const now = new Date(Date.now() + 7 * 3600e3);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const showNow = A.day === todayISO() && nowMin >= open && nowMin <= close;

  return `<div class="legend-a">
      <span><i style="background:var(--green)"></i>ยืนยันแล้ว</span><span><i style="background:#1e7a5c"></i>กำลังนวด</span>
      <span><i style="background:#6c86d1"></i>รอตรวจสลิป</span><span><i style="background:#e5b25d"></i>รอชำระ</span>
      <span><i style="background:#9aa39f"></i>เสร็จสิ้น</span><span>ลายขีด = เวลาเก็บเตียง ${buffer} นาที</span>
    </div>
    <div class="tl"><div class="tl-inner">
      <div class="tl-head"><div class="tl-label">เตียง</div><div class="tl-track">
        ${hours.map(m => `<div class="tl-hour" style="left:${pct(m)}">${String(m / 60).padStart(2, '0')}:00</div>`).join('')}
      </div></div>
      ${A.ref.beds.map(bed => `<div class="tl-row"><div class="tl-label">${esc(bed.name)}</div><div class="tl-track">
        ${hours.map(m => `<div class="tl-hour" style="left:${pct(m)}"></div>`).join('')}
        ${showNow ? `<div class="tl-now" style="left:${pct(nowMin)}"></div>` : ''}
        ${slotsByBed.get(bed.id).map(({ b, s }) => {
          const st = toMin(b.time), en = toMin(b.end_time);
          const w = ((en + buffer - st) / span) * 100;
          const bufW = buffer ? (buffer / (en + buffer - st)) * 100 : 0;
          return `<button class="blk ${b.status}" style="left:${pct(st)};width:${w}%" data-open="${b.id}" title="${esc(b.customer_name)} · ${esc(b.service_name)}">
            ${b.time} ${esc(b.customer_name)}${b.guests > 1 ? ` (${s.guest_no}/${b.guests})` : ''}
            <small>${esc(b.service_name)} ${b.duration_min}′ · ${esc(s.therapist || '-')}</small>
            ${bufW ? `<span class="buf" style="width:${bufW}%"></span>` : ''}</button>`;
        }).join('')}
      </div></div>`).join('')}
    </div></div>`;
}

// ---------- รายการ ----------
function renderList() {
  if (!A.bookings.length) return '<div class="empty"><div class="big">🗓️</div>ไม่มีการจองในวันนี้</div>';
  return `<table class="a-table"><thead><tr><th>เวลา</th><th>ลูกค้า</th><th>บริการ</th><th>เตียง / หมอ</th><th>ราคา</th><th>สถานะ</th></tr></thead><tbody>
    ${A.bookings.map(b => `<tr data-open="${b.id}">
      <td><b>${b.time}</b>–${b.end_time}</td>
      <td>${esc(b.customer_name)}<div class="small muted">${esc(b.phone || '')} · ${SOURCE[b.source] || b.source}</div></td>
      <td>${esc(b.service_name)} ${b.duration_min}′ × ${b.guests}${b.pressure ? `<div class="small muted">แรง${PRESSURE[b.pressure]}</div>` : ''}</td>
      <td class="small">${b.slots.map(s => `${esc(s.bed)} · ${esc(s.therapist || '-')}`).join('<br>')}</td>
      <td>${baht(b.total_price)}${b.amount_due > 0 ? `<div class="small muted">มัดจำ ${baht(b.amount_due)}</div>` : ''}</td>
      <td><span class="pill ${b.status}">${STATUS[b.status]}</span></td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- รอตรวจสลิป ----------
function renderReview() {
  if (!A.pending.length) return '<div class="empty"><div class="big">✅</div>ไม่มีสลิปรอตรวจ</div>';
  return `<div class="review-grid">${A.pending.map(b => `<div class="card">
      <div class="row-between"><b>${esc(b.code)}</b><span class="pill awaiting_review">รอตรวจ</span></div>
      <div class="small mt8">${esc(b.customer_name)} · ${esc(b.phone || '')}</div>
      <div class="small muted">${b.date} ${b.time} · ${esc(b.service_name)} ${b.duration_min}′ × ${b.guests}</div>
      <div class="mt8">ยอดที่ต้องได้รับ <b style="color:var(--clay)">${baht(b.amount_due)}</b></div>
      <img class="slip" data-slip="${esc(b.slip_path)}" alt="สลิป">
      <div class="btn-row mt12">
        <button class="btn danger" data-status="cancelled" data-id="${b.id}" data-reason="สลิปไม่ถูกต้อง">ไม่ผ่าน</button>
        <button class="btn" data-status="confirmed" data-id="${b.id}">ยืนยัน</button>
      </div></div>`).join('')}</div>`;
}

async function slipUrl(path) {
  if (!path) return '';
  const { data } = await A.sb.storage.from('slips').createSignedUrl(path, 600);
  return data?.signedUrl || '';
}
async function loadSlipImages() {
  for (const img of document.querySelectorAll('img[data-slip]')) {
    img.src = await slipUrl(img.dataset.slip);
    img.onclick = () => window.open(img.src, '_blank');
  }
}

// ---------- รายละเอียด ----------
async function openBooking(id) {
  const b = A.bookings.find(x => x.id === id) || A.pending.find(x => x.id === id);
  if (!b) return;
  const { data: extra } = await A.sb.from('bookings').select('slip_path, staff_note, line_user_id').eq('id', id).single();
  const url = await slipUrl(extra?.slip_path);
  const acts = {
    pending_payment: [['confirmed', 'ยืนยัน (รับเงินแล้ว)'], ['cancelled', 'ยกเลิก', 'danger']],
    awaiting_review: [['confirmed', 'สลิปถูกต้อง ยืนยัน'], ['cancelled', 'สลิปไม่ผ่าน ยกเลิก', 'danger']],
    confirmed: [['checked_in', 'ลูกค้ามาแล้ว'], ['no_show', 'ไม่มา', 'ghost'], ['cancelled', 'ยกเลิก', 'danger']],
    checked_in: [['completed', 'นวดเสร็จ / ชำระแล้ว']],
    completed: [],
    cancelled: [['confirmed', 'กู้คืนการจอง', 'ghost']],
    expired: [['confirmed', 'กู้คืนการจอง', 'ghost']],
    no_show: [['confirmed', 'กู้คืนการจอง', 'ghost']],
  }[b.status] || [];
  const editable = ['pending_payment', 'awaiting_review', 'confirmed', 'checked_in'].includes(b.status);

  sheet(`<div class="row-between"><h2>${esc(b.code)}</h2><span class="pill ${b.status}">${STATUS[b.status]}</span></div>
    <dl class="kv mt12">
      <dt>ลูกค้า</dt><dd>${esc(b.customer_name)} ${b.phone ? `· <a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}</dd>
      <dt>ช่องทาง</dt><dd>${SOURCE[b.source] || b.source}${extra?.line_user_id ? ' (แจ้งเตือน LINE ได้)' : ''}</dd>
      <dt>บริการ</dt><dd>${esc(b.service_name)} ${b.duration_min} นาที × ${b.guests} ท่าน</dd>
      <dt>เวลา</dt><dd>${b.date} · ${b.time}–${b.end_time} น.</dd>
      <dt>แรงนวด</dt><dd>${PRESSURE[b.pressure] || '-'}</dd>
      <dt>หมายเหตุ</dt><dd>${esc(b.note || '-')}</dd>
      <dt>ราคา</dt><dd>${baht(b.total_price)}${b.amount_due > 0 ? ` · มัดจำ ${baht(b.amount_due)}` : ''}</dd>
    </dl>
    <h3 class="mt16">เตียง / หมอนวด</h3>
    ${b.slots.map(s => `<div class="row-between mt8">
      <span class="small">คนที่ ${s.guest_no}</span>
      <select class="input" style="width:auto" data-move="${s.guest_no}" data-field="bed" ${editable ? '' : 'disabled'}>
        ${A.ref.beds.map(x => `<option value="${x.id}" ${x.id === s.bed_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select class="input" style="width:auto" data-move="${s.guest_no}" data-field="therapist" ${editable ? '' : 'disabled'}>
        ${A.ref.therapists.map(x => `<option value="${x.id}" ${x.id === s.therapist_id ? 'selected' : ''}>${esc(x.nickname)}</option>`).join('')}</select>
    </div>`).join('')}
    ${url ? `<h3 class="mt16">สลิป</h3><img src="${url}" alt="สลิป" style="max-width:100%;max-height:420px;border-radius:10px;margin-top:8px">` : ''}
    ${acts.length ? `<div class="act-grid mt16">${acts.map(([s, label, cls]) => `<button class="btn ${cls || ''}" data-status="${s}" data-id="${b.id}">${label}</button>`).join('')}</div>` : ''}`);
  $('#sheet .sheet-card').classList.add('wide');
  $('#sheet .sheet-card').onchange = async (e) => {
    const sel = e.target.closest('[data-move]');
    if (!sel) return;
    const args = { p_booking_id: b.id, p_guest_no: Number(sel.dataset.move), p_bed_id: null, p_therapist: null };
    if (sel.dataset.field === 'bed') args.p_bed_id = Number(sel.value); else args.p_therapist = sel.value;
    const { error } = await A.sb.rpc('admin_move_slot', args);
    if (error) { toast(/overlap/.test(error.message) ? 'ชนกับคิวอื่นในช่วงเวลานี้' : error.message, 3500); openBooking(b.id); return; }
    toast('ย้ายแล้ว'); await refresh();
  };
}

async function setStatus(id, status, reason) {
  const { error } = await A.sb.rpc('admin_set_status', { p_booking_id: id, p_status: status, p_note: reason || null });
  if (error) { toast(/overlap/.test(error.message) ? 'เตียงหรือหมอถูกจองไปแล้ว กู้คืนไม่ได้' : error.message, 3500); return; }
  sheet(null);
  toast(`อัปเดตเป็น "${STATUS[status]}"`);
  if (['confirmed', 'cancelled', 'completed'].includes(status)) {
    fetch('/api/admin-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.session.access_token}` },
      body: JSON.stringify({ bookingId: id, message: reason ? `เหตุผล: ${reason}` : undefined }),
    }).catch(() => {});
  }
  await refresh();
}

// ---------- Walk-in / รับจองทางโทรศัพท์ ----------
function openWalkin() {
  const opts = A.ref.services.flatMap(s => (s.service_options || []).filter(o => o.active)
    .sort((a, b) => a.duration_min - b.duration_min).map(o => ({ ...o, name: s.name, zone: s.bed_zone })));
  const now = new Date(Date.now() + 7 * 3600e3);
  sheet(`<h2>เพิ่มการจอง</h2>
    <form id="walkin" class="mt12">
      <div class="seg" style="margin-bottom:14px">
        <button type="button" class="selected" data-src="walk_in">Walk-in</button><button type="button" data-src="phone">ลูกค้าโทรจอง</button></div>
      <label class="field"><span>บริการ</span><select class="input" name="option">${opts.map(o => `<option value="${o.id}" data-dur="${o.duration_min}" data-zone="${esc(o.zone || '')}">${esc(o.name)} ${o.duration_min} นาที · ${baht(o.price)}</option>`).join('')}</select></label>
      <div class="btn-row">
        <label class="field"><span>วันที่</span><input class="input" type="date" name="date" value="${A.day}"></label>
        <label class="field"><span>จำนวนคน</span><input class="input" type="number" name="guests" value="1" min="1" max="15"></label>
      </div>
      <label class="field"><span>หมอนวด</span><select class="input" name="therapist"><option value="">ร้านจัดให้</option>${A.ref.therapists.map(t => `<option value="${t.id}">${esc(t.nickname)}</option>`).join('')}</select></label>
      <label class="field"><span>เวลาเริ่ม</span><select class="input" name="time" required><option>กำลังโหลด…</option></select></label>
      <div class="btn-row">
        <label class="field"><span>ชื่อลูกค้า</span><input class="input" name="name" required maxlength="80"></label>
        <label class="field"><span>เบอร์โทร</span><input class="input" name="phone" type="tel" maxlength="13"></label>
      </div>
      <label class="field"><span>หมายเหตุ</span><input class="input" name="note" maxlength="300"></label>
      <button class="btn block">บันทึกการจอง</button>
    </form>`);
  const f = $('#walkin');
  let source = 'walk_in';
  const loadTimes = async () => {
    const o = f.option.selectedOptions[0];
    const { data, error } = await A.sb.rpc('get_availability', {
      p_date: f.date.value, p_duration: Number(o.dataset.dur), p_guests: Number(f.guests.value) || 1,
      p_zone: o.dataset.zone || null, p_therapist: f.therapist.value || null,
    });
    if (error) { toast(error.message); return; }
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    // พนักงานรับ walk-in ได้แม้เวลาใกล้มาก จึงแสดงตามเตียง/หมอว่าง ไม่สน min_lead
    const ok = (data || []).filter(s => s.beds_free >= (Number(f.guests.value) || 1) && s.therapists_free >= (Number(f.guests.value) || 1)
      && !(f.date.value === todayISO() && toMin(s.slot_time) + 30 < nowMin));
    f.time.innerHTML = ok.length ? ok.map(s => `<option value="${s.slot_time}">${s.slot_time} (ว่าง ${Math.min(s.beds_free, s.therapists_free)})</option>`).join('')
      : '<option value="">ไม่มีเวลาว่าง</option>';
  };
  f.addEventListener('change', (e) => { if (e.target.name !== 'time' && ['option', 'date', 'guests', 'therapist'].includes(e.target.name)) loadTimes(); });
  f.addEventListener('click', (e) => {
    const s = e.target.closest('[data-src]');
    if (!s) return;
    source = s.dataset.src;
    f.querySelectorAll('[data-src]').forEach(x => x.classList.toggle('selected', x === s));
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!f.time.value) return toast('เลือกเวลา');
    const { data, error } = await A.sb.rpc('admin_create_booking', {
      p_name: f.name.value, p_phone: f.phone.value, p_option_id: Number(f.option.value), p_guests: Number(f.guests.value),
      p_date: f.date.value, p_time: f.time.value, p_therapist: f.therapist.value || null, p_note: f.note.value || null, p_source: source,
    });
    if (error) { toast(error.message.replace('NO_BED', 'เตียงเต็ม').replace('NO_THERAPIST', 'หมอไม่ว่าง').replace('THERAPIST_BUSY', 'หมอที่เลือกไม่ว่าง'), 3500); return; }
    sheet(null);
    toast(`บันทึกแล้ว ${data.code} · ${data.slots.map(s => s.bed).join(', ')}`, 4000);
    if (f.date.value !== A.day) { A.day = f.date.value; $('#day').value = A.day; }
    await refresh();
  });
  loadTimes();
}

// ---------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const v = e.target.closest('[data-view]');
  if (v) { A.view = v.dataset.view; return render(); }
  const o = e.target.closest('[data-open]');
  if (o) return openBooking(o.dataset.open);
  const st = e.target.closest('[data-status]');
  if (st) {
    let reason = st.dataset.reason;
    if (st.dataset.status === 'cancelled' && !reason) reason = prompt('เหตุผลการยกเลิก (ส่งให้ลูกค้าทาง LINE)', '') ?? undefined;
    if (reason === undefined && st.dataset.status === 'cancelled') return;
    return setStatus(st.dataset.id, st.dataset.status, reason);
  }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  if (a.dataset.action === 'day') { A.day = addDays(A.day, Number(a.dataset.d)); $('#day').value = A.day; refresh(); }
  if (a.dataset.action === 'today') { A.day = todayISO(); $('#day').value = A.day; refresh(); }
  if (a.dataset.action === 'walkin') openWalkin();
  if (a.dataset.action === 'logout') { await A.sb.auth.signOut(); location.reload(); }
});
$('#day').addEventListener('change', (e) => { A.day = e.target.value || todayISO(); refresh(); });

boot();
