// POST /api/book — สร้างการจองจาก LIFF
import { handler, verifyLineUser, rpc, sb, linePush, bookingFlex, getSettings, thaiDate, HttpError } from './_lib.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default handler(async (body) => {
  const user = await verifyLineUser(body.idToken);
  const { optionId, guests, date, time, therapistId, name, phone, pressure, note } = body;

  if (!Number.isInteger(optionId) || !Number.isInteger(guests)) throw new HttpError(400, 'ข้อมูลไม่ครบ');
  if (!DATE_RE.test(date || '') || !TIME_RE.test(time || '')) throw new HttpError(400, 'วันเวลาไม่ถูกต้อง');
  if (therapistId && !UUID_RE.test(therapistId)) throw new HttpError(400, 'หมอนวดไม่ถูกต้อง');
  if (pressure && !['soft', 'medium', 'strong'].includes(pressure)) throw new HttpError(400, 'ระดับแรงนวดไม่ถูกต้อง');
  const cleanPhone = String(phone || '').replace(/[^\d+]/g, '');
  if (cleanPhone.length < 9 || cleanPhone.length > 13) throw new HttpError(400, 'เบอร์โทรไม่ถูกต้อง');

  // บันทึก/อัปเดตข้อมูลลูกค้า (จำไว้ใช้ครั้งหน้า)
  await sb('/rest/v1/customers?on_conflict=line_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{
      line_user_id: user.userId,
      display_name: user.name,
      picture_url: user.picture,
      full_name: String(name || '').slice(0, 80),
      phone: cleanPhone,
      pressure: pressure || null,
    }],
  });

  const booking = await rpc('create_booking', {
    p_line_user_id: user.userId,
    p_name: String(name || '').slice(0, 80),
    p_phone: cleanPhone,
    p_option_id: optionId,
    p_guests: guests,
    p_date: date,
    p_time: time,
    p_therapist: therapistId || null,
    p_pressure: pressure || null,
    p_note: String(note || '').slice(0, 300) || null,
    p_source: 'liff',
  });

  const settings = await getSettings();
  if (booking.status === 'confirmed') {
    await Promise.all([
      linePush(user.userId, [bookingFlex(booking, { title: 'จองคิวสำเร็จ', shopName: settings.shop_name })]),
      linePush(process.env.LINE_ADMIN_TO, [{
        type: 'text',
        text: `🆕 จองใหม่ ${booking.code}\n${booking.customer_name} (${booking.phone})\n${booking.service_name} ${booking.duration_min} นาที × ${booking.guests}\n${thaiDate(booking.date)} ${booking.time} น.`,
      }]),
    ]);
  }

  return { booking };
});
