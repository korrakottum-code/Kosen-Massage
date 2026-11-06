// POST /api/cancel — ลูกค้ายกเลิกการจองเอง (ตามเงื่อนไข cancel_before_hours)
import { handler, verifyLineUser, rpc, linePush, thaiDate, HttpError } from './_lib.js';

export default handler(async (body) => {
  const user = await verifyLineUser(body.idToken);
  if (!/^[0-9a-f-]{36}$/i.test(body.bookingId || '')) throw new HttpError(400, 'ไม่พบการจอง');
  const booking = await rpc('cancel_customer_booking', { p_booking_id: body.bookingId, p_line_user_id: user.userId });
  if (booking.has_slip || booking.amount_due > 0) {
    await linePush(process.env.LINE_ADMIN_TO, [{
      type: 'text',
      text: `❌ ลูกค้ายกเลิก ${booking.code}\n${booking.customer_name} (${booking.phone})\n${thaiDate(booking.date)} ${booking.time} น.${booking.has_slip ? '\n⚠️ มีสลิปโอนแล้ว ตรวจสอบการคืนเงิน' : ''}`,
    }]);
  }
  return { booking };
});
