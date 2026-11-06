// POST /api/slip — แนบสลิปโอนเงิน (รูป jpeg base64, บีบอัดจากฝั่งเครื่องลูกค้าแล้ว)
import { handler, verifyLineUser, rpc, sb, linePush, thaiDate, HttpError } from './_lib.js';

const MAX_BYTES = 2.5 * 1024 * 1024;

export default handler(async (body) => {
  const user = await verifyLineUser(body.idToken);
  const { bookingId, image } = body;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId || '')) throw new HttpError(400, 'ไม่พบการจอง');

  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!m) throw new HttpError(400, 'ไฟล์รูปไม่ถูกต้อง');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_BYTES) throw new HttpError(400, 'รูปใหญ่เกินไป');

  // ตรวจว่าเป็นการจองของผู้ใช้นี้ก่อนอัปโหลด
  const own = await sb(`/rest/v1/bookings?id=eq.${bookingId}&line_user_id=eq.${encodeURIComponent(user.userId)}&select=id,code`);
  if (!own?.length) throw new HttpError(404, 'ไม่พบการจอง');

  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const path = `${new Date().toISOString().slice(0, 7)}/${own[0].code}-${Date.now()}.${ext}`;
  const up = await sb(`/storage/v1/object/slips/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': `image/${m[1]}`, 'x-upsert': 'false' },
    body: new Uint8Array(bytes),
    raw: true,
  });
  if (!up.ok) {
    console.error('slip upload failed', up.status, await up.text());
    throw new HttpError(500, 'อัปโหลดสลิปไม่สำเร็จ');
  }

  const booking = await rpc('attach_slip', { p_booking_id: bookingId, p_line_user_id: user.userId, p_path: path });

  const adminUrl = process.env.PUBLIC_BASE_URL ? `\nตรวจสลิป: ${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/admin` : '';
  await linePush(process.env.LINE_ADMIN_TO, [{
    type: 'text',
    text: `💸 สลิปใหม่ ${booking.code} ฿${booking.amount_due}\n${booking.customer_name} (${booking.phone})\n${booking.service_name} ${booking.duration_min} นาที × ${booking.guests}\n${thaiDate(booking.date)} ${booking.time} น.${adminUrl}`,
  }]);

  return { booking };
});
