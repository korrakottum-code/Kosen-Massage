-- ข้อมูลตั้งต้นของร้าน Kosen (แก้ไขได้ภายหลังจาก Supabase Table Editor หรือหน้า admin)

update public.shop_settings set
  shop_name = 'Kosen Massage',
  tagline = 'นวดเพื่อสุขภาพ · ขอนแก่น',
  address = 'อ.เมือง จ.ขอนแก่น',
  open_time = '10:00',
  close_time = '22:00',
  payment_mode = 'deposit',
  deposit_per_guest = 100,
  promptpay_id = null,          -- ใส่เบอร์ PromptPay ของร้าน เช่น '0812345678'
  announcement = 'จองล่วงหน้าได้ 14 วัน · มาก่อนเวลา 10 นาทีเพื่อเปลี่ยนชุด'
where id = 1;

-- 15 เตียง
insert into public.beds (name, zone, sort)
select 'เตียง ' || g, 'main', g from generate_series(1, 15) g;

-- บริการ
insert into public.services (id, name, name_en, description, category, sort) values
  (1, 'นวดแผนไทย',            'Thai Massage',          'นวดกดจุดและยืดเหยียดตามแบบแผนไทย คลายกล้ามเนื้อทั่วร่างกาย', 'massage', 1),
  (2, 'นวดเท้า',              'Foot Reflexology',      'นวดกดจุดฝ่าเท้าและน่อง ช่วยการไหลเวียนเลือด', 'massage', 2),
  (3, 'นวดน้ำมัน',            'Oil Massage',           'นวดผ่อนคลายด้วยน้ำมันนวด ลงน้ำหนักนุ่มนวล', 'massage', 3),
  (4, 'นวดอโรมา',             'Aromatherapy Massage',  'นวดน้ำมันหอมระเหย ช่วยให้หลับสบาย ลดความเครียด', 'massage', 4),
  (5, 'ออฟฟิศซินโดรม',        'Office Syndrome',       'เน้นคอ บ่า ไหล่ หลัง สำหรับคนนั่งทำงานนาน', 'therapy', 5),
  (6, 'นวดไทย + ประคบสมุนไพร', 'Thai Massage + Herbal Compress', 'นวดไทยต่อด้วยลูกประคบสมุนไพรอุ่น ๆ', 'therapy', 6);
select setval('public.services_id_seq', 6);

insert into public.service_options (service_id, duration_min, price) values
  (1, 60, 250), (1, 90, 350), (1, 120, 450),
  (2, 60, 250), (2, 90, 350),
  (3, 60, 400), (3, 90, 550), (3, 120, 700),
  (4, 60, 450), (4, 90, 600), (4, 120, 750),
  (5, 60, 450), (5, 90, 600),
  (6, 90, 450), (6, 120, 550);

-- หมอนวด (ตัวอย่าง 15 คน แก้ชื่อ/รูป/วันหยุดได้)
insert into public.therapists (nickname, gender, specialties, days_off, sort)
select 'หมอ ' || g,
       case when g % 4 = 0 then 'male' else 'female' end,
       case when g % 3 = 0 then array['นวดน้ำมัน', 'อโรมา']
            when g % 3 = 1 then array['นวดไทย', 'ออฟฟิศซินโดรม']
            else array['นวดเท้า', 'นวดไทย'] end,
       array[(g % 7)],
       g
from generate_series(1, 15) g;

insert into public.promo_banners (title, body, sort) values
  ('ลูกค้าใหม่', 'จองผ่าน LINE ครั้งแรก รับฟรีชาสมุนไพรหลังนวด', 1),
  ('มา 2 คนคุ้มกว่า', 'จองคู่ นวดพร้อมกันเตียงติดกัน', 2);
