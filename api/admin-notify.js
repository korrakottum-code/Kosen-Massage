// POST /api/admin-notify — พนักงานกดยืนยัน/ยกเลิกใน admin แล้วส่ง LINE แจ้งลูกค้า
import { handler, verifyStaff, sb, rpc, linePush, bookingFlex, getSettings, HttpError } from './_lib.js';

const TITLES = {
  confirmed: ['ยืนยันการจองแล้ว', '#2f5d50'],
  cancelled: ['การจองถูกยกเลิก', '#9b3b3b'],
  completed: ['ขอบคุณที่ใช้บริการ', '#2f5d50'],
};

export default handler(async (body, req) => {
  await verifyStaff(req);
  if (!/^[0-9a-f-]{36}$/i.test(body.bookingId || '')) throw new HttpError(400, 'bad id');
  const rows = await sb(`/rest/v1/bookings?id=eq.${body.bookingId}&select=line_user_id`);
  const to = rows?.[0]?.line_user_id;
  if (!to) return { sent: false, reason: 'no-line-user' };
  const booking = await rpc('booking_json', { p_id: body.bookingId });
  const [title, color] = TITLES[booking.status] || ['อัปเดตการจอง', '#2f5d50'];
  const settings = await getSettings();
  const messages = [bookingFlex(booking, { title, color, shopName: settings.shop_name })];
  if (body.message) messages.push({ type: 'text', text: String(body.message).slice(0, 500) });
  const sent = await linePush(to, messages);
  return { sent };
});
