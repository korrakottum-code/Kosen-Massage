// POST /api/my-bookings — ประวัติการจองของลูกค้า + ข้อมูลที่เคยกรอก
import { handler, verifyLineUser, rpc, sb } from './_lib.js';

export default handler(async (body) => {
  const user = await verifyLineUser(body.idToken);
  const [bookings, customer] = await Promise.all([
    rpc('get_customer_bookings', { p_line_user_id: user.userId }),
    sb(`/rest/v1/customers?line_user_id=eq.${encodeURIComponent(user.userId)}&select=full_name,phone,pressure,visits`),
  ]);
  return { bookings, customer: customer?.[0] || null };
});
