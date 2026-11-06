-- =====================================================================
-- Kosen Massage · ระบบจองคิวร้านนวดเพื่อสุขภาพ (ขอนแก่น, 15 เตียง)
-- Supabase / Postgres schema
--
-- แนวคิด:
--   bookings       = 1 การจอง (หัวบิล: ลูกค้า, บริการ, สถานะ, การชำระเงิน)
--   booking_slots  = 1 แถวต่อ 1 คน (เตียง + หมอนวด + ช่วงเวลา)
--   กันจองซ้อนด้วย exclusion constraint ทั้งระดับ "เตียง" และ "หมอนวด"
--   ลูกค้าเรียกผ่าน /api (Vercel) ที่ตรวจ LINE ID token แล้วใช้ service role
--   พนักงานหน้าร้านใช้ admin.html (Supabase Auth + ตาราง staff)
-- =====================================================================

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- ตั้งค่าร้าน (แถวเดียว)
-- ---------------------------------------------------------------------
create table public.shop_settings (
  id                    int primary key default 1 check (id = 1),
  shop_name             text not null default 'Kosen Massage',
  tagline               text default 'นวดเพื่อสุขภาพ · ขอนแก่น',
  address               text default 'จังหวัดขอนแก่น',
  phone                 text,
  map_url               text,
  line_oa_url           text,
  open_time             time not null default '10:00',
  close_time            time not null default '22:00',   -- เวลาที่ต้องนวดเสร็จ
  slot_minutes          int  not null default 30 check (slot_minutes in (15, 30, 60)),
  buffer_minutes        int  not null default 10 check (buffer_minutes between 0 and 60), -- เก็บเตียง/พักหมอ
  min_lead_minutes      int  not null default 30,        -- ต้องจองล่วงหน้าอย่างน้อย
  max_days_ahead        int  not null default 14,
  max_guests            int  not null default 4 check (max_guests between 1 and 15),
  cancel_before_hours   int  not null default 3,         -- ยกเลิกเองได้ก่อนเวลากี่ชม.
  payment_mode          text not null default 'deposit'
                        check (payment_mode in ('none', 'deposit', 'full')),
  deposit_per_guest     numeric(10,2) not null default 100,
  hold_minutes          int  not null default 10,        -- เวลาให้โอน+แนบสลิป
  promptpay_id          text,                            -- เบอร์มือถือ / เลขบัตร ปชช. / เลขผู้เสียภาษี
  bank_name             text,
  account_name          text,
  account_number        text,
  announcement          text,
  updated_at            timestamptz not null default now()
);
insert into public.shop_settings (id) values (1);

-- ---------------------------------------------------------------------
-- เตียง (ทรัพยากรหลัก)
-- ---------------------------------------------------------------------
create table public.beds (
  id        serial primary key,
  name      text not null,
  zone      text not null default 'main',   -- เช่น main / foot / vip (ใช้คู่กับ services.bed_zone)
  active    boolean not null default true,
  sort      int not null default 0
);

-- ---------------------------------------------------------------------
-- หมอนวด
-- ---------------------------------------------------------------------
create table public.therapists (
  id          uuid primary key default gen_random_uuid(),
  nickname    text not null,
  gender      text check (gender in ('female', 'male', 'other')),
  photo_url   text,
  specialties text[] not null default '{}',
  bio         text,
  work_start  time not null default '10:00',
  work_end    time not null default '22:00',
  days_off    int[] not null default '{}',     -- 0=อาทิตย์ … 6=เสาร์
  bookable    boolean not null default true,   -- ให้ลูกค้าเลือกชื่อได้
  active      boolean not null default true,
  sort        int not null default 0
);

create table public.therapist_leaves (
  therapist_id uuid not null references public.therapists(id) on delete cascade,
  leave_date   date not null,
  note         text,
  primary key (therapist_id, leave_date)
);

-- ---------------------------------------------------------------------
-- บริการ + ราคา/ระยะเวลา
-- ---------------------------------------------------------------------
create table public.services (
  id          serial primary key,
  name        text not null,
  name_en     text,
  description text,
  image_url   text,
  category    text not null default 'massage',
  bed_zone    text,                 -- null = ใช้เตียงไหนก็ได้
  active      boolean not null default true,
  sort        int not null default 0
);

create table public.service_options (
  id           serial primary key,
  service_id   int not null references public.services(id) on delete cascade,
  duration_min int not null check (duration_min between 15 and 300),
  price        numeric(10,2) not null check (price >= 0),
  active       boolean not null default true,
  unique (service_id, duration_min)
);

create table public.holidays (
  holiday_date date primary key,
  note         text
);

create table public.promo_banners (
  id        serial primary key,
  title     text not null,
  body      text,
  image_url text,
  active    boolean not null default true,
  sort      int not null default 0
);

-- ---------------------------------------------------------------------
-- ลูกค้า (ผูกกับ LINE userId)
-- ---------------------------------------------------------------------
create table public.customers (
  line_user_id  text primary key,
  display_name  text,
  picture_url   text,
  full_name     text,
  phone         text,
  pressure      text,
  note          text,
  visits        int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- การจอง
-- ---------------------------------------------------------------------
create sequence public.booking_code_seq start 1001;

create table public.bookings (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  line_user_id     text references public.customers(line_user_id),
  source           text not null default 'liff' check (source in ('liff', 'walk_in', 'phone')),
  customer_name    text not null,
  phone            text,
  service_id       int references public.services(id),
  option_id        int references public.service_options(id),
  service_name     text not null,          -- snapshot
  duration_min     int not null,
  guests           int not null default 1 check (guests between 1 and 15),
  start_at         timestamptz not null,
  end_at           timestamptz not null,
  therapist_pref   uuid references public.therapists(id),
  pressure         text check (pressure in ('soft', 'medium', 'strong')),
  note             text,
  unit_price       numeric(10,2) not null,
  total_price      numeric(10,2) not null,
  amount_due       numeric(10,2) not null default 0,   -- ต้องโอนตอนจอง (มัดจำ/เต็ม)
  status           text not null default 'pending_payment'
                   check (status in ('pending_payment', 'awaiting_review', 'confirmed',
                                     'checked_in', 'completed', 'cancelled', 'expired', 'no_show')),
  hold_expires_at  timestamptz,
  slip_path        text,
  slip_uploaded_at timestamptz,
  staff_note       text,
  cancelled_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index bookings_start_idx on public.bookings (start_at);
create index bookings_user_idx  on public.bookings (line_user_id, start_at desc);
create index bookings_status_idx on public.bookings (status);

create table public.booking_slots (
  id            bigserial primary key,
  booking_id    uuid not null references public.bookings(id) on delete cascade,
  guest_no      int not null default 1,
  bed_id        int not null references public.beds(id),
  therapist_id  uuid references public.therapists(id),
  start_at      timestamptz not null,
  end_at        timestamptz not null,      -- เวลานวดเสร็จ
  block_end     timestamptz not null,      -- end_at + buffer (กันเตียง/หมอ)
  active        boolean not null default true,
  check (end_at > start_at and block_end >= end_at),
  constraint no_bed_overlap exclude using gist
    (bed_id with =, tstzrange(start_at, block_end) with &&) where (active),
  constraint no_therapist_overlap exclude using gist
    (therapist_id with =, tstzrange(start_at, block_end) with &&) where (active and therapist_id is not null)
);
create index booking_slots_booking_idx on public.booking_slots (booking_id);
create index booking_slots_time_idx on public.booking_slots using gist (tstzrange(start_at, block_end)) where (active);

-- ---------------------------------------------------------------------
-- พนักงาน (ใช้กับ Supabase Auth)
-- ---------------------------------------------------------------------
create table public.staff (
  user_id    uuid primary key,          -- = auth.users.id
  name       text not null,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now()
);

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

-- =====================================================================
-- Triggers
-- =====================================================================
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger bookings_touch before update on public.bookings
  for each row execute function public.touch_updated_at();
create trigger customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();

-- ปลดเตียง/หมอเมื่อการจองถูกยกเลิก/หมดเวลา/ไม่มา
create or replace function public.sync_slot_active() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    update public.booking_slots
       set active = new.status not in ('cancelled', 'expired', 'no_show')
     where booking_id = new.id;
    if new.status = 'completed' and old.status <> 'completed' and new.line_user_id is not null then
      update public.customers set visits = visits + 1 where line_user_id = new.line_user_id;
    end if;
  end if;
  return new;
end $$;

create trigger bookings_status_sync after update of status on public.bookings
  for each row execute function public.sync_slot_active();

-- =====================================================================
-- Functions (RPC)
-- =====================================================================

-- เวลาในร้านใช้โซน Asia/Bangkok เสมอ
create or replace function public.shop_ts(p_date date, p_time time) returns timestamptz
language sql immutable as $$
  select (p_date + p_time) at time zone 'Asia/Bangkok';
$$;

-- ปล่อยคิวที่ค้างชำระเกินเวลา
create or replace function public.expire_holds() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.bookings
     set status = 'expired'
   where status = 'pending_payment'
     and hold_expires_at is not null
     and hold_expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- หมอว่างในช่วงเวลา?
create or replace function public.therapist_free(p_tid uuid, p_start timestamptz, p_end timestamptz, p_block_end timestamptz)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.therapists t
     where t.id = p_tid and t.active
       and not (extract(dow from p_start at time zone 'Asia/Bangkok')::int = any (t.days_off))
       and not exists (select 1 from public.therapist_leaves l
                        where l.therapist_id = t.id
                          and l.leave_date = (p_start at time zone 'Asia/Bangkok')::date)
       and (p_start at time zone 'Asia/Bangkok')::time >= t.work_start
       and (p_end   at time zone 'Asia/Bangkok')::time <= t.work_end
       and (p_end at time zone 'Asia/Bangkok')::date = (p_start at time zone 'Asia/Bangkok')::date
  )
  and not exists (
    select 1 from public.booking_slots s
      join public.bookings b on b.id = s.booking_id
     where s.therapist_id = p_tid and s.active
       and not (b.status = 'pending_payment' and b.hold_expires_at < now())
       and tstzrange(s.start_at, s.block_end) && tstzrange(p_start, p_block_end)
  );
$$;

create or replace function public.bed_free(p_bed int, p_start timestamptz, p_block_end timestamptz)
returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.booking_slots s
      join public.bookings b on b.id = s.booking_id
     where s.bed_id = p_bed and s.active
       and not (b.status = 'pending_payment' and b.hold_expires_at < now())
       and tstzrange(s.start_at, s.block_end) && tstzrange(p_start, p_block_end)
  );
$$;

-- ตารางเวลาว่างของวัน (ลูกค้าเรียกได้โดยตรงผ่าน anon key)
create or replace function public.get_availability(
  p_date date, p_duration int, p_guests int default 1, p_zone text default null, p_therapist uuid default null
) returns table (slot_time text, beds_free int, therapists_free int, available boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  s public.shop_settings;
  t time;
  st timestamptz; en timestamptz; be timestamptz;
  nb int; nt int;
begin
  select * into s from public.shop_settings where id = 1;
  if p_date is null or p_duration is null or p_duration <= 0 then return; end if;
  if p_date < (now() at time zone 'Asia/Bangkok')::date
     or p_date > (now() at time zone 'Asia/Bangkok')::date + s.max_days_ahead
     or exists (select 1 from public.holidays h where h.holiday_date = p_date) then
    return;
  end if;

  t := s.open_time;
  while t + make_interval(mins => p_duration) <= s.close_time
        and t + make_interval(mins => p_duration) > t loop
    st := public.shop_ts(p_date, t);
    en := st + make_interval(mins => p_duration);
    be := en + make_interval(mins => s.buffer_minutes);

    select count(*) into nb from public.beds b
     where b.active and (p_zone is null or b.zone = p_zone)
       and public.bed_free(b.id, st, be);

    if p_therapist is not null then
      nt := case when public.therapist_free(p_therapist, st, en, be) then 1 else 0 end;
      -- คนแรกได้หมอที่เลือก คนที่เหลือใช้หมอว่างคนอื่น
      if nt = 1 and p_guests > 1 then
        select 1 + count(*) into nt from public.therapists th
         where th.id <> p_therapist and public.therapist_free(th.id, st, en, be);
      end if;
    else
      select count(*) into nt from public.therapists th
       where public.therapist_free(th.id, st, en, be);
    end if;

    slot_time := to_char(t, 'HH24:MI');
    beds_free := nb;
    therapists_free := nt;
    available := nb >= p_guests and nt >= p_guests
                 and st >= now() + make_interval(mins => s.min_lead_minutes);
    return next;

    t := t + make_interval(mins => s.slot_minutes);
  end loop;
end $$;

-- สร้างการจอง (เรียกจาก /api/book ด้วย service role หรือ admin_create_booking)
create or replace function public.create_booking(
  p_line_user_id text,
  p_name text,
  p_phone text,
  p_option_id int,
  p_guests int,
  p_date date,
  p_time text,
  p_therapist uuid default null,
  p_pressure text default null,
  p_note text default null,
  p_source text default 'liff'
) returns json
language plpgsql security definer set search_path = public as $$
declare
  s public.shop_settings;
  o public.service_options;
  sv public.services;
  st timestamptz; en timestamptz; be timestamptz;
  bk public.bookings;
  bed_ids int[];
  th_ids uuid[];
  i int;
  v_amount numeric;
  v_status text;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'NAME_REQUIRED'; end if;
  if p_source = 'liff' and coalesce(trim(p_phone), '') = '' then raise exception 'PHONE_REQUIRED'; end if;

  select * into s from public.shop_settings where id = 1;
  select * into o from public.service_options where id = p_option_id and active;
  if not found then raise exception 'SERVICE_NOT_FOUND'; end if;
  select * into sv from public.services where id = o.service_id and active;
  if not found then raise exception 'SERVICE_NOT_FOUND'; end if;

  if p_guests is null or p_guests < 1 or p_guests > s.max_guests then raise exception 'BAD_GUESTS'; end if;

  st := public.shop_ts(p_date, p_time::time);
  en := st + make_interval(mins => o.duration_min);
  be := en + make_interval(mins => s.buffer_minutes);

  if p_source = 'liff' then
    if st < now() + make_interval(mins => s.min_lead_minutes) then raise exception 'TOO_LATE'; end if;
    if p_date > (now() at time zone 'Asia/Bangkok')::date + s.max_days_ahead then raise exception 'TOO_FAR'; end if;
    if exists (select 1 from public.holidays where holiday_date = p_date) then raise exception 'SHOP_CLOSED'; end if;
    if p_time::time < s.open_time or (en at time zone 'Asia/Bangkok')::time > s.close_time
       or (en at time zone 'Asia/Bangkok')::date <> p_date then
      raise exception 'OUTSIDE_HOURS';
    end if;
  end if;

  -- ล็อกทั้งวัน: ป้องกันสองคนกดจองพร้อมกันแล้วได้เตียงเดียวกัน
  perform pg_advisory_xact_lock(hashtext('kosen-day-' || p_date::text));
  perform public.expire_holds();

  -- เลือกเตียงว่าง
  select array_agg(id) into bed_ids from (
    select b.id from public.beds b
     where b.active and (sv.bed_zone is null or b.zone = sv.bed_zone)
       and public.bed_free(b.id, st, be)
     order by b.sort, b.id
     limit p_guests
  ) x;
  if coalesce(array_length(bed_ids, 1), 0) < p_guests then raise exception 'NO_BED'; end if;

  -- เลือกหมอ: คนที่ลูกค้าระบุก่อน ที่เหลือเฉลี่ยงานให้หมอที่มีคิวน้อยสุดของวัน
  th_ids := '{}';
  if p_therapist is not null then
    if not public.therapist_free(p_therapist, st, en, be) then raise exception 'THERAPIST_BUSY'; end if;
    th_ids := array[p_therapist];
  end if;
  if coalesce(array_length(th_ids, 1), 0) < p_guests then
    th_ids := th_ids || array(
      select t.id from public.therapists t
       where t.id <> all (th_ids)
         and public.therapist_free(t.id, st, en, be)
       order by (select count(*) from public.booking_slots bs
                  where bs.therapist_id = t.id and bs.active
                    and (bs.start_at at time zone 'Asia/Bangkok')::date = p_date),
                t.sort, t.nickname
       limit p_guests - coalesce(array_length(th_ids, 1), 0)
    );
  end if;
  if coalesce(array_length(th_ids, 1), 0) < p_guests then raise exception 'NO_THERAPIST'; end if;

  v_amount := case s.payment_mode
                when 'none'    then 0
                when 'deposit' then least(s.deposit_per_guest, o.price) * p_guests
                else o.price * p_guests
              end;
  v_status := case when v_amount > 0 and p_source = 'liff' then 'pending_payment' else 'confirmed' end;

  insert into public.bookings (
    code, line_user_id, source, customer_name, phone, service_id, option_id, service_name,
    duration_min, guests, start_at, end_at, therapist_pref, pressure, note,
    unit_price, total_price, amount_due, status, hold_expires_at
  ) values (
    'KS' || to_char(p_date, 'YYMMDD') || '-' || lpad((nextval('public.booking_code_seq') % 10000)::text, 4, '0'),
    p_line_user_id, p_source, trim(p_name), nullif(trim(p_phone), ''), sv.id, o.id, sv.name,
    o.duration_min, p_guests, st, en, p_therapist, p_pressure, nullif(trim(p_note), ''),
    o.price, o.price * p_guests,
    case when v_status = 'pending_payment' then v_amount else 0 end,
    v_status,
    case when v_status = 'pending_payment' then now() + make_interval(mins => s.hold_minutes) end
  ) returning * into bk;

  for i in 1 .. p_guests loop
    insert into public.booking_slots (booking_id, guest_no, bed_id, therapist_id, start_at, end_at, block_end)
    values (bk.id, i, bed_ids[i], th_ids[i], st, en, be);
  end loop;

  return public.booking_json(bk.id);
end $$;

-- รายละเอียดการจองแบบ JSON (ใช้ร่วมทั้งลูกค้า/แอดมิน)
create or replace function public.booking_json(p_id uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', b.id, 'code', b.code, 'status', b.status, 'source', b.source,
    'customer_name', b.customer_name, 'phone', b.phone,
    'service_name', b.service_name, 'duration_min', b.duration_min, 'guests', b.guests,
    'start_at', b.start_at, 'end_at', b.end_at,
    'date', to_char(b.start_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD'),
    'time', to_char(b.start_at at time zone 'Asia/Bangkok', 'HH24:MI'),
    'end_time', to_char(b.end_at at time zone 'Asia/Bangkok', 'HH24:MI'),
    'pressure', b.pressure, 'note', b.note,
    'unit_price', b.unit_price, 'total_price', b.total_price, 'amount_due', b.amount_due,
    'hold_expires_at', b.hold_expires_at, 'has_slip', b.slip_path is not null,
    'created_at', b.created_at,
    'slots', coalesce((
      select json_agg(json_build_object(
               'guest_no', s.guest_no, 'bed', bd.name, 'bed_id', bd.id,
               'therapist', t.nickname, 'therapist_id', t.id) order by s.guest_no)
        from public.booking_slots s
        join public.beds bd on bd.id = s.bed_id
        left join public.therapists t on t.id = s.therapist_id
       where s.booking_id = b.id), '[]'::json)
  )
  from public.bookings b where b.id = p_id;
$$;

-- ลูกค้าแนบสลิป
create or replace function public.attach_slip(p_booking_id uuid, p_line_user_id text, p_path text)
returns json
language plpgsql security definer set search_path = public as $$
declare bk public.bookings;
begin
  perform public.expire_holds();
  select * into bk from public.bookings
   where id = p_booking_id and line_user_id = p_line_user_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if bk.status = 'expired' then raise exception 'HOLD_EXPIRED'; end if;
  if bk.status not in ('pending_payment', 'awaiting_review') then raise exception 'BAD_STATUS'; end if;
  update public.bookings
     set slip_path = p_path, slip_uploaded_at = now(), status = 'awaiting_review', hold_expires_at = null
   where id = bk.id;
  return public.booking_json(bk.id);
end $$;

create or replace function public.get_customer_bookings(p_line_user_id text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform public.expire_holds();
  return coalesce((
    select json_agg(public.booking_json(b.id) order by b.start_at desc)
      from (select id, start_at from public.bookings
             where line_user_id = p_line_user_id
             order by start_at desc limit 50) b
  ), '[]'::json);
end $$;

create or replace function public.cancel_customer_booking(p_booking_id uuid, p_line_user_id text)
returns json
language plpgsql security definer set search_path = public as $$
declare bk public.bookings; s public.shop_settings;
begin
  select * into s from public.shop_settings where id = 1;
  select * into bk from public.bookings
   where id = p_booking_id and line_user_id = p_line_user_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if bk.status not in ('pending_payment', 'awaiting_review', 'confirmed') then raise exception 'BAD_STATUS'; end if;
  if bk.status <> 'pending_payment'
     and bk.start_at < now() + make_interval(hours => s.cancel_before_hours) then
    raise exception 'TOO_LATE_TO_CANCEL';
  end if;
  update public.bookings set status = 'cancelled', cancelled_reason = 'customer' where id = bk.id;
  return public.booking_json(bk.id);
end $$;

-- ---- ฝั่งพนักงาน ------------------------------------------------------
create or replace function public.admin_create_booking(
  p_name text, p_phone text, p_option_id int, p_guests int, p_date date, p_time text,
  p_therapist uuid default null, p_note text default null, p_source text default 'walk_in'
) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  if p_source not in ('walk_in', 'phone') then raise exception 'BAD_SOURCE'; end if;
  return public.create_booking(null, p_name, p_phone, p_option_id, p_guests, p_date, p_time,
                               p_therapist, null, p_note, p_source);
end $$;

create or replace function public.admin_set_status(p_booking_id uuid, p_status text, p_note text default null)
returns json
language plpgsql security definer set search_path = public as $$
declare bk public.bookings;
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  select * into bk from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  -- กู้คืนคิวที่ยกเลิก: ต้องเช็คว่าเตียง/หมอยังว่าง (exclusion constraint จะ error ถ้าชน)
  update public.bookings
     set status = p_status,
         hold_expires_at = null,
         staff_note = coalesce(p_note, staff_note),
         cancelled_reason = case when p_status = 'cancelled' then coalesce(p_note, 'staff') else cancelled_reason end
   where id = bk.id;
  return public.booking_json(bk.id);
end $$;

create or replace function public.admin_move_slot(p_booking_id uuid, p_guest_no int, p_bed_id int, p_therapist uuid)
returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  update public.booking_slots
     set bed_id = coalesce(p_bed_id, bed_id), therapist_id = coalesce(p_therapist, therapist_id)
   where booking_id = p_booking_id and guest_no = p_guest_no;
  return public.booking_json(p_booking_id);
end $$;

create or replace function public.admin_day(p_date date) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  perform public.expire_holds();
  return coalesce((
    select json_agg(public.booking_json(b.id) order by b.start_at)
      from public.bookings b
     where (b.start_at at time zone 'Asia/Bangkok')::date = p_date
  ), '[]'::json);
end $$;

create or replace function public.admin_pending() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  perform public.expire_holds();
  return coalesce((
    select jsonb_agg(public.booking_json(b.id)::jsonb ||
             jsonb_build_object('slip_path', b.slip_path) order by b.slip_uploaded_at)
      from public.bookings b where b.status = 'awaiting_review'
  )::json, '[]'::json);
end $$;

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.shop_settings    enable row level security;
alter table public.beds             enable row level security;
alter table public.therapists       enable row level security;
alter table public.therapist_leaves enable row level security;
alter table public.services         enable row level security;
alter table public.service_options  enable row level security;
alter table public.holidays         enable row level security;
alter table public.promo_banners    enable row level security;
alter table public.customers        enable row level security;
alter table public.bookings         enable row level security;
alter table public.booking_slots    enable row level security;
alter table public.staff            enable row level security;

-- ข้อมูลสาธารณะ: ใครก็อ่านได้
create policy public_read on public.shop_settings   for select using (true);
create policy public_read on public.beds            for select using (true);
create policy public_read on public.therapists      for select using (active and bookable or public.is_staff());
create policy public_read on public.services        for select using (active or public.is_staff());
create policy public_read on public.service_options for select using (active or public.is_staff());
create policy public_read on public.holidays        for select using (true);
create policy public_read on public.promo_banners   for select using (active or public.is_staff());

-- พนักงานแก้ไขได้ทุกอย่าง
create policy staff_all on public.shop_settings    for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.beds             for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.therapists       for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.therapist_leaves for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.services         for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.service_options  for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.holidays         for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.promo_banners    for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.customers        for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.bookings         for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on public.booking_slots    for all using (public.is_staff()) with check (public.is_staff());
create policy staff_read on public.staff           for select using (public.is_staff());

-- สิทธิ์เรียกฟังก์ชัน
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_availability(date, int, int, text, uuid) to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.admin_create_booking(text, text, int, int, date, text, uuid, text, text) to authenticated;
grant execute on function public.admin_set_status(uuid, text, text) to authenticated;
grant execute on function public.admin_move_slot(uuid, int, int, uuid) to authenticated;
grant execute on function public.admin_day(date) to authenticated;
grant execute on function public.admin_pending() to authenticated;
-- create_booking / attach_slip / get_customer_bookings / cancel_customer_booking
-- เรียกได้เฉพาะ service_role (ผ่าน /api ที่ตรวจ LINE token แล้ว)
grant execute on all functions in schema public to service_role;

-- =====================================================================
-- Storage: สลิปโอนเงิน (private)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('slips', 'slips', false)
on conflict (id) do nothing;

create policy "staff read slips" on storage.objects
  for select using (bucket_id = 'slips' and public.is_staff());
