# Kosen Massage · ระบบจองคิวร้านนวดผ่าน LINE

แอปจองคิวร้านนวดเพื่อสุขภาพ **Kosen** (จ.ขอนแก่น, 15 เตียง) เปิดใน LINE ผ่าน LIFF
โครงสร้างเดียวกับแอปจองสนาม 42SC (LIFF + Supabase + Vercel + PromptPay + แนบสลิป) แต่ปรับให้เข้ากับร้านนวด

## เทียบกับแอปต้นแบบ (42SC)

| แอปจองสนาม 42SC | Kosen Massage |
|---|---|
| สนาม (court) | **เตียง 15 เตียง** (`beds`) |
| ประเภทกีฬา Tennis / Badminton / Golf | **บริการ** นวดไทย, นวดเท้า, น้ำมัน, อโรมา, ออฟฟิศซินโดรม, ประคบสมุนไพร (`services` + `service_options` ตามเวลา 60/90/120 นาที) |
| โค้ช (เพิ่มได้) | **หมอนวด** เลือกเองหรือ "ไม่ระบุ" ให้ร้านจัด (`therapists`, วันหยุด, ลางาน) |
| จองเป็นชั่วโมงต่อสนาม | จองตาม **ระยะเวลานวด + เวลาเก็บเตียง** และจองได้ **หลายคนพร้อมกัน** (1–4 ท่าน) |
| ล็อกช่องเวลา 10 นาทีระหว่างจ่ายเงิน | เหมือนกัน (`hold_minutes`) หมดเวลาแล้วปล่อยคิวอัตโนมัติ |
| PromptPay QR + แนบสลิป | เหมือนกัน + เลือกได้ว่าเก็บ **มัดจำ / เต็มจำนวน / ไม่เก็บ** |
| ส่งการ์ดยืนยันเข้า LINE | Flex message ยืนยัน/ยกเลิก/ขอบคุณ ไปหาลูกค้า + แจ้งเตือนกลุ่มร้าน |
| หน้า Home / Bookings / Profile | หน้าแรก / จองคิว / การจองของฉัน / ร้าน |
| — | **หน้าหลังร้าน** `/admin`: ตารางเตียงรายวัน, ตรวจสลิป, เช็คอิน, ย้ายเตียง/หมอ, รับ walk-in และลูกค้าโทรจอง |

## ขั้นตอนการจองของลูกค้า

1. เลือกบริการ + ระยะเวลา
2. เลือกจำนวนคน, วันที่ (ล่วงหน้าได้ 14 วัน), หมอนวด (ไม่บังคับ), เวลา — แสดงเวลาที่ว่างจริงตามเตียงและหมอที่เหลือ
3. กรอกชื่อ เบอร์ น้ำหนักมือ (เบา/กลาง/หนัก) และหมายเหตุ (จุดที่ปวด, ตั้งครรภ์ ฯลฯ)
4. สแกน PromptPay (ยอดใส่ไว้แล้ว) → แนบสลิปภายใน 10 นาที
5. ร้านตรวจสลิปในหน้า admin → ลูกค้าได้ข้อความยืนยันใน LINE

## โครงสร้างไฟล์

```
public/                 หน้าเว็บ (static)
  index.html            แอปลูกค้า (เปิดผ่าน LIFF)
  admin.html            หน้าหลังร้านสำหรับพนักงาน
  assets/app.js         logic ฝั่งลูกค้า
  assets/backend.js     ติดต่อ Supabase / API + โหมดทดลอง
  assets/promptpay.js   สร้าง QR พร้อมเพย์ (EMVCo)
  assets/admin.js       logic หน้าหลังร้าน
api/                    Vercel Serverless Functions
  config.js             ส่งค่า LIFF ID / Supabase URL ให้หน้าเว็บ
  book.js               สร้างการจอง (ตรวจ LINE ID token ก่อน)
  slip.js               อัปโหลดสลิป → แจ้งเตือนร้าน
  my-bookings.js        ประวัติการจองของลูกค้า
  cancel.js             ลูกค้ายกเลิกเอง
  admin-notify.js       พนักงานยืนยัน/ยกเลิก → ส่ง LINE หาลูกค้า
supabase/
  migrations/…_init.sql ตาราง, ฟังก์ชันจองคิว, RLS, bucket สลิป
  seed.sql              ข้อมูลเริ่มต้น: 15 เตียง, บริการ+ราคา, หมอนวดตัวอย่าง
```

กันการจองซ้อนที่ระดับฐานข้อมูลด้วย exclusion constraint (เตียงเดียวกัน/หมอคนเดียวกันซ้อนเวลาไม่ได้) และล็อกรายวันตอนสร้างการจอง ลูกค้า 2 คนกดพร้อมกันก็ไม่ได้เตียงเดียวกัน

## ทดลองดูก่อนตั้งค่า

```bash
cd public && python3 -m http.server 8080
# เปิด http://localhost:8080/?demo  → โหมดทดลอง ใช้ข้อมูลจำลอง ไม่ต้องมี LINE/Supabase
```

## ติดตั้งใช้งานจริง

### 1) Supabase
1. สร้างโปรเจกต์ที่ [supabase.com](https://supabase.com) (เลือก region Singapore)
2. SQL Editor → รัน `supabase/migrations/20261106000000_init.sql` แล้วตามด้วย `supabase/seed.sql`
3. แก้ข้อมูลร้านในตาราง `shop_settings`: `promptpay_id`, บัญชีธนาคาร, เบอร์โทร, ที่อยู่, ลิงก์แผนที่, `payment_mode` (`none` / `deposit` / `full`), `deposit_per_guest`
4. แก้ชื่อ/รูป/วันหยุดหมอนวดในตาราง `therapists` (`days_off`: 0=อาทิตย์ … 6=เสาร์) และราคาใน `service_options`
5. สร้างบัญชีพนักงาน: Authentication → Add user (อีเมล+รหัสผ่าน) แล้วรัน
   ```sql
   insert into staff (user_id, name, role) values ('<user id>', 'เจ้าของร้าน', 'owner');
   ```

### 2) LINE
1. [LINE Developers](https://developers.line.biz/console/) → สร้าง Provider
2. สร้าง **LINE Login channel** → แท็บ LIFF → Add: Size `Full`, Endpoint URL `https://<โดเมน vercel>/`, Scope `openid` + `profile`, Bot link `On (Aggressive)` → ได้ **LIFF ID**
3. ใช้ **Messaging API channel** ของ LINE OA ร้าน → ออก **Channel access token (long-lived)**
4. ใส่ลิงก์ `https://liff.line.me/<LIFF ID>` ใน Rich menu ของ LINE OA (ปุ่ม "จองคิว")
5. `LINE_ADMIN_TO`: userId ของเจ้าของร้าน หรือ groupId ของกลุ่มพนักงาน (ต้องเชิญ OA เข้ากลุ่ม)

### 3) Vercel
1. Import repo นี้ที่ [vercel.com](https://vercel.com) (Framework: Other, ไม่ต้องตั้ง build command)
2. ใส่ Environment Variables ตาม `.env.example`
3. Deploy แล้วนำโดเมนไปใส่เป็น Endpoint URL ของ LIFF
4. หน้าหลังร้าน: `https://<โดเมน>/admin`

## ทดสอบ

```bash
npm test   # ทดสอบการสร้าง QR พร้อมเพย์
```

## ต่อยอดได้

- คูปอง/โปรโมชัน (ต้นแบบมี `promo_codes`), สะสมแต้ม/แพ็กเกจคอร์ส
- ส่ง LINE เตือนก่อนถึงเวลานัด (Supabase cron + Messaging API)
- ตรวจสลิปอัตโนมัติผ่านบริการ slip verification
- ภาษาอังกฤษสำหรับลูกค้าต่างชาติ
