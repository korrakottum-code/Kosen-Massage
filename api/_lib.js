// Shared helpers for Vercel serverless functions (no npm deps; Node 20+ fetch)
// ไฟล์ที่ขึ้นต้นด้วย _ ใน /api จะไม่ถูกสร้างเป็น endpoint

const env = (k, fallback) => {
  const v = process.env[k];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(500, `Missing env ${k}`);
  }
  return v;
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ข้อความ error ภาษาไทยที่ส่งกลับให้ลูกค้า (มาจาก raise exception ใน SQL)
const DB_ERRORS = {
  NAME_REQUIRED: 'กรุณากรอกชื่อ',
  PHONE_REQUIRED: 'กรุณากรอกเบอร์โทร',
  SERVICE_NOT_FOUND: 'ไม่พบบริการที่เลือก',
  BAD_GUESTS: 'จำนวนคนไม่ถูกต้อง',
  TOO_LATE: 'เวลานี้ใกล้เกินไป กรุณาเลือกเวลาถัดไป',
  TOO_FAR: 'จองล่วงหน้าได้ไม่เกินที่ร้านกำหนด',
  SHOP_CLOSED: 'ร้านปิดในวันที่เลือก',
  OUTSIDE_HOURS: 'เวลานวดเกินเวลาเปิด-ปิดร้าน',
  NO_BED: 'ขออภัย เตียงเต็มในช่วงเวลานี้แล้ว',
  NO_THERAPIST: 'ขออภัย หมอนวดไม่ว่างในช่วงเวลานี้',
  THERAPIST_BUSY: 'หมอนวดที่เลือกไม่ว่างในช่วงเวลานี้',
  NOT_FOUND: 'ไม่พบการจอง',
  HOLD_EXPIRED: 'หมดเวลาชำระเงิน กรุณาจองใหม่',
  BAD_STATUS: 'สถานะการจองไม่สามารถทำรายการนี้ได้',
  TOO_LATE_TO_CANCEL: 'ใกล้เวลานัดแล้ว ไม่สามารถยกเลิกเองได้ กรุณาติดต่อร้าน',
};

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function handler(fn, { method = 'POST' } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== method) {
      res.statusCode = 405;
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
    try {
      const body = method === 'POST' ? await readJson(req) : {};
      const out = await fn(body, req);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(JSON.stringify(out ?? {}));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = status;
      res.end(JSON.stringify({ error: status >= 500 && !e.expose ? 'เกิดข้อผิดพลาด กรุณาลองใหม่' : e.message }));
    }
  };
}

// ---------- LINE ----------

// ตรวจ ID token จาก liff.getIDToken() กับ LINE แล้วคืน { userId, name, picture }
export async function verifyLineUser(idToken) {
  if (!idToken) throw new HttpError(401, 'กรุณาเข้าสู่ระบบด้วย LINE');
  const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: env('LINE_LOGIN_CHANNEL_ID') }),
  });
  if (!r.ok) throw new HttpError(401, 'เซสชัน LINE หมดอายุ กรุณาเปิดแอปใหม่');
  const p = await r.json();
  return { userId: p.sub, name: p.name || '', picture: p.picture || '' };
}

export async function linePush(to, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !to) return false;
  const targets = String(to).split(',').map(s => s.trim()).filter(Boolean);
  const results = await Promise.allSettled(targets.map(t =>
    fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: t, messages }),
    }).then(async r => { if (!r.ok) console.warn('LINE push failed', r.status, await r.text()); return r.ok; })
  ));
  return results.some(r => r.status === 'fulfilled' && r.value);
}

// ---------- Supabase (service role) ----------

const sbUrl = () => env('SUPABASE_URL').replace(/\/$/, '');
const sbKey = () => env('SUPABASE_SERVICE_ROLE_KEY');

export async function sb(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const r = await fetch(`${sbUrl()}${path}`, {
    method,
    headers: {
      apikey: sbKey(),
      Authorization: `Bearer ${sbKey()}`,
      ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body)),
  });
  if (raw) return r;
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const code = data?.message || data?.error || `HTTP ${r.status}`;
    if (DB_ERRORS[code]) throw new HttpError(400, DB_ERRORS[code]);
    if (/no_bed_overlap|no_therapist_overlap/.test(code)) throw new HttpError(409, DB_ERRORS.NO_BED);
    const err = new HttpError(500, `Supabase: ${code}`);
    throw err;
  }
  return data;
}

export const rpc = (name, args) => sb(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });

export async function getSettings() {
  const rows = await sb('/rest/v1/shop_settings?id=eq.1&select=*');
  return rows?.[0] || {};
}

// ตรวจว่า access token ของ Supabase Auth เป็นพนักงานจริง (ใช้ใน /api/admin-notify)
export async function verifyStaff(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Unauthorized');
  const r = await fetch(`${sbUrl()}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new HttpError(401, 'Unauthorized');
  const user = await r.json();
  const rows = await sb(`/rest/v1/staff?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,name,role`);
  if (!rows?.length) throw new HttpError(403, 'Forbidden');
  return rows[0];
}

// ---------- ข้อความ LINE ----------

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
export function thaiDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${TH_DAYS[dow]} ${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

export const STATUS_TH = {
  pending_payment: 'รอชำระเงิน',
  awaiting_review: 'รอร้านตรวจสลิป',
  confirmed: 'ยืนยันแล้ว',
  checked_in: 'เช็คอินแล้ว',
  completed: 'เสร็จสิ้น',
  cancelled: 'ยกเลิก',
  expired: 'หมดเวลาชำระ',
  no_show: 'ไม่มาตามนัด',
};

const baht = n => `฿${Number(n || 0).toLocaleString('th-TH')}`;

export function bookingFlex(b, { title = 'การจองของคุณ', color = '#2f5d50', shopName = 'Kosen Massage' } = {}) {
  const row = (k, v) => ({
    type: 'box', layout: 'horizontal', spacing: 'md', contents: [
      { type: 'text', text: k, size: 'sm', color: '#8a8a8a', flex: 3 },
      { type: 'text', text: String(v), size: 'sm', color: '#222222', flex: 6, wrap: true },
    ],
  });
  const therapists = (b.slots || []).map(s => s.therapist).filter(Boolean).join(', ');
  return {
    type: 'flex',
    altText: `${title} ${b.code} · ${thaiDate(b.date)} ${b.time}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '16px', contents: [
          { type: 'text', text: shopName, color: '#ffffffcc', size: 'xs' },
          { type: 'text', text: title, color: '#ffffff', size: 'lg', weight: 'bold' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: b.code, weight: 'bold', size: 'md' },
          { type: 'separator', margin: 'md' },
          row('บริการ', `${b.service_name} ${b.duration_min} นาที`),
          row('วันที่', thaiDate(b.date)),
          row('เวลา', `${b.time} – ${b.end_time} น.`),
          row('จำนวน', `${b.guests} ท่าน`),
          ...(therapists ? [row('หมอนวด', therapists)] : []),
          row('ราคารวม', baht(b.total_price)),
          row('สถานะ', STATUS_TH[b.status] || b.status),
        ],
      },
    },
  };
}
