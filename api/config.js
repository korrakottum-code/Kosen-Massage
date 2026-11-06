// GET /api/config — ค่าสาธารณะสำหรับหน้าเว็บ (ไม่มีความลับ)
import { handler } from './_lib.js';

export default handler(async () => ({
  liffId: process.env.LIFF_ID || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  lineOaUrl: process.env.LINE_OA_URL || '',
}), { method: 'GET' });
