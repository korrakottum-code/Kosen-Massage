// ชั้นติดต่อข้อมูล: โหมดจริง (LIFF + Supabase + /api) และโหมดทดลอง (ข้อมูลจำลองในเครื่อง)

const todayISO = (offset = 0) => {
  const d = new Date(Date.now() + 7 * 3600e3); // เวลาไทย
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function json(r) {
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!r.ok) throw new ApiError(data?.error || data?.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่', r.status);
  return data;
}

// ===================================================================
// โหมดจริง
// ===================================================================
function realBackend(cfg) {
  const rest = (path, init = {}) => fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.supabaseAnonKey,
      Authorization: `Bearer ${cfg.supabaseAnonKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  }).then(json);

  const idToken = () => window.liff.getIDToken();
  const api = (path, body = {}) => fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, idToken: idToken() }),
  }).then(json);

  return {
    demo: false,
    lineOaUrl: cfg.lineOaUrl,

    async login() {
      await window.liff.init({ liffId: cfg.liffId });
      if (!window.liff.isLoggedIn()) {
        window.liff.login({ redirectUri: location.href });
        return new Promise(() => {}); // กำลัง redirect
      }
      const p = await window.liff.getProfile();
      return { userId: p.userId, name: p.displayName, picture: p.pictureUrl, inClient: window.liff.isInClient() };
    },

    async catalog() {
      const [settings, services, therapists, holidays, banners] = await Promise.all([
        rest('shop_settings?id=eq.1&select=*'),
        rest('services?select=*,service_options(*)&order=sort.asc'),
        rest('therapists?select=id,nickname,gender,photo_url,specialties,bio,days_off,work_start,work_end&order=sort.asc'),
        rest(`holidays?select=holiday_date,note&holiday_date=gte.${todayISO()}`),
        rest('promo_banners?select=*&order=sort.asc'),
      ]);
      return { settings: settings[0] || {}, services, therapists, holidays, banners };
    },

    availability({ date, duration, guests, zone, therapistId }) {
      return rest('rpc/get_availability', {
        method: 'POST',
        body: JSON.stringify({ p_date: date, p_duration: duration, p_guests: guests, p_zone: zone || null, p_therapist: therapistId || null }),
      });
    },

    book: (payload) => api('book', payload).then(r => r.booking),
    uploadSlip: (bookingId, image) => api('slip', { bookingId, image }).then(r => r.booking),
    myBookings: () => api('my-bookings'),
    cancel: (bookingId) => api('cancel', { bookingId }).then(r => r.booking),

  };
}

// ===================================================================
// โหมดทดลอง (เปิดนอก LINE หรือยังไม่ได้ตั้งค่า) — ข้อมูลเหมือน supabase/seed.sql
// ===================================================================
function demoBackend() {
  const KEY = 'kosen-demo-bookings';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ } };
  const wait = (ms = 250) => new Promise(r => setTimeout(r, ms));

  const settings = {
    shop_name: 'Kosen Massage', tagline: 'นวดเพื่อสุขภาพ · ขอนแก่น', address: 'อ.เมือง จ.ขอนแก่น',
    phone: '043-000-000', map_url: '', line_oa_url: '',
    open_time: '10:00:00', close_time: '22:00:00', slot_minutes: 30, buffer_minutes: 10, min_lead_minutes: 30,
    max_days_ahead: 14, max_guests: 4, cancel_before_hours: 3,
    payment_mode: 'deposit', deposit_per_guest: 100, hold_minutes: 10,
    promptpay_id: '0812345678', bank_name: 'กสิกรไทย', account_name: 'บจก. โคเซ็น มาสสาจ (ตัวอย่าง)', account_number: '123-4-56789-0',
    announcement: 'จองล่วงหน้าได้ 14 วัน · มาก่อนเวลา 10 นาทีเพื่อเปลี่ยนชุด',
  };
  const svc = (id, name, name_en, description, opts) => ({
    id, name, name_en, description, category: 'massage', bed_zone: null, active: true, sort: id, image_url: null,
    service_options: opts.map(([d, p], i) => ({ id: id * 10 + i, service_id: id, duration_min: d, price: p, active: true })),
  });
  const services = [
    svc(1, 'นวดแผนไทย', 'Thai Massage', 'นวดกดจุดและยืดเหยียดตามแบบแผนไทย คลายกล้ามเนื้อทั่วร่างกาย', [[60, 250], [90, 350], [120, 450]]),
    svc(2, 'นวดเท้า', 'Foot Reflexology', 'นวดกดจุดฝ่าเท้าและน่อง ช่วยการไหลเวียนเลือด', [[60, 250], [90, 350]]),
    svc(3, 'นวดน้ำมัน', 'Oil Massage', 'นวดผ่อนคลายด้วยน้ำมันนวด ลงน้ำหนักนุ่มนวล', [[60, 400], [90, 550], [120, 700]]),
    svc(4, 'นวดอโรมา', 'Aromatherapy Massage', 'นวดน้ำมันหอมระเหย ช่วยให้หลับสบาย ลดความเครียด', [[60, 450], [90, 600], [120, 750]]),
    svc(5, 'ออฟฟิศซินโดรม', 'Office Syndrome', 'เน้นคอ บ่า ไหล่ หลัง สำหรับคนนั่งทำงานนาน', [[60, 450], [90, 600]]),
    svc(6, 'นวดไทย + ประคบสมุนไพร', 'Thai Massage + Herbal Compress', 'นวดไทยต่อด้วยลูกประคบสมุนไพรอุ่น ๆ', [[90, 450], [120, 550]]),
  ];
  const names = ['แพรว', 'น้ำฝน', 'บี', 'ต่าย', 'เอ', 'นุช', 'ปุ้ย', 'ก้อย', 'ตั๊ก', 'จอย', 'แป้ง', 'ฝ้าย', 'หนิง', 'ออย', 'มด'];
  const therapists = names.map((n, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    nickname: n, gender: (i + 1) % 4 === 0 ? 'male' : 'female', photo_url: null,
    specialties: [['นวดไทย', 'ออฟฟิศซินโดรม'], ['นวดเท้า', 'นวดไทย'], ['นวดน้ำมัน', 'อโรมา']][(i + 1) % 3],
    days_off: [(i + 1) % 7], work_start: '10:00:00', work_end: '22:00:00',
  }));
  const banners = [
    { id: 1, title: 'ลูกค้าใหม่', body: 'จองผ่าน LINE ครั้งแรก รับฟรีชาสมุนไพรหลังนวด' },
    { id: 2, title: 'มา 2 คนคุ้มกว่า', body: 'จองคู่ นวดพร้อมกันเตียงติดกัน' },
  ];

  // ความหนาแน่นจำลอง: ช่วงเย็นคนเยอะ
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const nowBangkokMin = () => { const d = new Date(Date.now() + 7 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const fakeBusy = (date, m) => {
    const evening = m >= 17 * 60 && m < 21 * 60 ? 3 : 0;
    return Math.min(15, (hash(date + m) % 7) + evening + (new Date(date).getDay() % 6 === 0 ? 3 : 0));
  };

  let profile = { userId: 'Udemo', name: 'ลูกค้าทดลอง', picture: '', inClient: false };

  const enrich = (b) => {
    if (b.status === 'pending_payment' && new Date(b.hold_expires_at) < new Date()) b.status = 'expired';
    return b;
  };

  return {
    demo: true,
    lineOaUrl: '',
    async login() { await wait(150); return profile; },
    async catalog() { await wait(); return { settings, services, therapists, holidays: [], banners }; },

    async availability({ date, duration, guests, therapistId }) {
      await wait(200);
      const open = toMin(settings.open_time), close = toMin(settings.close_time);
      const out = [];
      const mine = load().map(enrich).filter(b => b.date === date && !['cancelled', 'expired', 'no_show'].includes(b.status));
      for (let m = open; m + duration <= close; m += settings.slot_minutes) {
        let busy = 0;
        for (let x = m; x < m + duration; x += 30) busy = Math.max(busy, fakeBusy(date, x));
        for (const b of mine) {
          const bs = toMin(b.time), be = bs + b.duration_min + settings.buffer_minutes;
          if (bs < m + duration + settings.buffer_minutes && m < be) busy += b.guests;
        }
        const beds = Math.max(0, 15 - busy);
        const th = therapistId ? (hash(therapistId + date + m) % 4 === 0 ? 0 : beds) : Math.max(0, beds - 2);
        const past = date === todayISO() && m < nowBangkokMin() + settings.min_lead_minutes;
        out.push({ slot_time: fromMin(m), beds_free: beds, therapists_free: th, available: !past && beds >= guests && th >= guests });
      }
      return out;
    },

    async book(p) {
      await wait(500);
      const s = services.flatMap(x => x.service_options.map(o => ({ ...o, svc: x }))).find(o => o.id === p.optionId);
      if (!s) throw new ApiError('ไม่พบบริการที่เลือก');
      const list = load();
      const due = settings.payment_mode === 'none' ? 0 : settings.payment_mode === 'deposit'
        ? Math.min(settings.deposit_per_guest, s.price) * p.guests : s.price * p.guests;
      const th = p.therapistId ? therapists.find(t => t.id === p.therapistId) : null;
      const end = toMin(p.time) + s.duration_min;
      const b = {
        id: crypto.randomUUID?.() || String(Date.now()),
        code: `KS${p.date.slice(2).replace(/-/g, '')}-${String(1001 + list.length).slice(-4)}`,
        status: due > 0 ? 'pending_payment' : 'confirmed',
        customer_name: p.name, phone: p.phone, service_name: s.svc.name, duration_min: s.duration_min, guests: p.guests,
        date: p.date, time: p.time, end_time: fromMin(end), pressure: p.pressure, note: p.note,
        unit_price: s.price, total_price: s.price * p.guests, amount_due: due, has_slip: false,
        hold_expires_at: due > 0 ? new Date(Date.now() + settings.hold_minutes * 60e3).toISOString() : null,
        created_at: new Date().toISOString(),
        slots: Array.from({ length: p.guests }, (_, i) => ({
          guest_no: i + 1, bed: `เตียง ${3 + i}`, therapist: i === 0 && th ? th.nickname : names[(hash(p.time) + i) % names.length],
        })),
      };
      list.push(b); save(list);
      localStorage.setItem('kosen-demo-customer', JSON.stringify({ full_name: p.name, phone: p.phone, pressure: p.pressure }));
      return b;
    },

    async uploadSlip(bookingId) {
      await wait(700);
      const list = load();
      const b = list.find(x => x.id === bookingId);
      if (!b) throw new ApiError('ไม่พบการจอง');
      enrich(b);
      if (b.status === 'expired') throw new ApiError('หมดเวลาชำระเงิน กรุณาจองใหม่');
      b.status = 'awaiting_review'; b.has_slip = true; b.hold_expires_at = null;
      save(list);
      return b;
    },

    async myBookings() {
      await wait();
      const list = load().map(enrich); save(list);
      let customer = null;
      try { customer = JSON.parse(localStorage.getItem('kosen-demo-customer') || 'null'); } catch { /* ignore */ }
      return { bookings: list.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)), customer };
    },

    async cancel(bookingId) {
      await wait();
      const list = load();
      const b = list.find(x => x.id === bookingId);
      if (b) b.status = 'cancelled';
      save(list);
      return b;
    },

  };
}

export async function createBackend() {
  const params = new URLSearchParams(location.search);
  let cfg = null;
  if (!params.has('demo')) {
    try { cfg = await fetch('/api/config').then(r => (r.ok ? r.json() : null)); } catch { cfg = null; }
  }
  if (cfg?.liffId && cfg?.supabaseUrl && cfg?.supabaseAnonKey && window.liff) return realBackend(cfg);
  return demoBackend();
}

export { todayISO, ApiError };
