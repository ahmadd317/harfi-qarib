-- حرفي قريب: run this file once in Supabase SQL Editor.
-- The browser only receives the publishable anon key; RLS and these RPCs
-- enforce all balance, role, cap, status and rating rules server-side.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role text not null default 'customer' check (role in ('customer', 'technician', 'admin')),
  specialties text[] not null default '{}',
  balance integer not null default 0 check (balance >= 0),
  free_requests_used integer not null default 0 check (free_requests_used >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  technician_id uuid references public.profiles(id) on delete set null,
  service_type text not null,
  area text not null,
  description text not null,
  preferred_time text not null,
  image_url text,
  status text not null default 'new' check (status in ('new', 'contacted', 'scheduled', 'visited', 'completed', 'no_agreement', 'cancelled')),
  contact_unlocked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.request_access (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.service_requests(id) on delete cascade,
  technician_id uuid not null references public.profiles(id) on delete cascade,
  fee integer not null default 0 check (fee >= 0),
  is_free boolean not null default false,
  created_at timestamptz not null default now(),
  unique (request_id, technician_id)
);

create table if not exists public.ratings (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.service_requests(id) on delete cascade,
  rater_id uuid not null references public.profiles(id) on delete cascade,
  ratee_id uuid not null references public.profiles(id) on delete cascade,
  score integer not null check (score between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (request_id, rater_id)
);

create table if not exists public.topup_receipts (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null check (amount >= 1000),
  receipt_url text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists service_requests_customer_idx on public.service_requests(customer_id, created_at desc);
create index if not exists service_requests_technician_idx on public.service_requests(technician_id, created_at desc);
create index if not exists service_requests_available_idx on public.service_requests(status, technician_id);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'phone', ''),
    case when new.raw_user_meta_data->>'role' = 'technician' then 'technician' else 'customer' end
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    phone = excluded.phone;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists service_requests_touch on public.service_requests;
create trigger service_requests_touch before update on public.service_requests
for each row execute procedure public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.service_requests enable row level security;
alter table public.request_access enable row level security;
alter table public.ratings enable row level security;
alter table public.topup_receipts enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists requests_select on public.service_requests;
create policy requests_select on public.service_requests for select to authenticated
using (
  customer_id = auth.uid()
  or technician_id = auth.uid()
  or (status = 'new' and technician_id is null and exists (select 1 from public.profiles where id = auth.uid() and role = 'technician'))
  or public.is_admin()
);
drop policy if exists requests_insert on public.service_requests;
create policy requests_insert on public.service_requests for insert to authenticated
with check (
  customer_id = auth.uid()
  and technician_id is null
  and contact_unlocked = false
  and status = 'new'
);
drop policy if exists requests_update on public.service_requests;
create policy requests_update on public.service_requests for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists access_select on public.request_access;
create policy access_select on public.request_access for select to authenticated
using (technician_id = auth.uid() or public.is_admin() or exists (
  select 1 from public.service_requests r where r.id = request_id and r.customer_id = auth.uid()
));

drop policy if exists ratings_select on public.ratings;
create policy ratings_select on public.ratings for select to authenticated
using (rater_id = auth.uid() or ratee_id = auth.uid() or public.is_admin());

drop policy if exists receipts_select on public.topup_receipts;
create policy receipts_select on public.topup_receipts for select to authenticated
using (technician_id = auth.uid() or public.is_admin());
drop policy if exists receipts_insert on public.topup_receipts;
create policy receipts_insert on public.topup_receipts for insert to authenticated
with check (technician_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'technician'));

-- Only the RPC can claim a request, so the fee and three-active-request cap
-- cannot be bypassed by editing browser code.
create or replace function public.claim_request(p_request_id uuid)
returns public.service_requests
language plpgsql security definer set search_path = public
as $$
declare
  r public.service_requests;
  p public.profiles;
  charge integer := 0;
begin
  select * into p from public.profiles where id = auth.uid() and role = 'technician' for update;
  if p.id is null then raise exception 'يجب تسجيل الدخول كفني'; end if;
  select * into r from public.service_requests where id = p_request_id for update;
  if r.id is null then raise exception 'الطلب غير موجود'; end if;
  if r.technician_id is not null then raise exception 'تم حجز هذا الطلب من فني آخر'; end if;
  if (select count(*) from public.service_requests
      where technician_id = p.id and status not in ('completed', 'cancelled', 'no_agreement')) >= 3
  then raise exception 'لديك 3 طلبات نشطة. أغلق أحدها قبل فتح طلب جديد'; end if;
  if p.free_requests_used >= 4 then
    charge := 10000;
    if p.balance < charge then raise exception 'رصيدك غير كافٍ، اشحن الرصيد أولًا'; end if;
    update public.profiles set balance = balance - charge where id = p.id;
  else
    update public.profiles set free_requests_used = free_requests_used + 1 where id = p.id;
  end if;
  insert into public.request_access(request_id, technician_id, fee, is_free)
  values (r.id, p.id, charge, charge = 0);
  update public.service_requests
  set technician_id = p.id, contact_unlocked = true, status = 'contacted'
  where id = r.id returning * into r;
  return r;
end;
$$;

create or replace function public.update_request_status(p_request_id uuid, p_status text)
returns public.service_requests
language plpgsql security definer set search_path = public
as $$
declare r public.service_requests;
begin
  if p_status not in ('scheduled', 'visited', 'completed', 'no_agreement', 'cancelled') then
    raise exception 'حالة غير صالحة';
  end if;
  update public.service_requests set status = p_status
  where id = p_request_id and (customer_id = auth.uid() or technician_id = auth.uid() or public.is_admin())
  returning * into r;
  if r.id is null then raise exception 'لا تملك صلاحية تحديث هذا الطلب'; end if;
  return r;
end;
$$;

create or replace function public.submit_rating(p_request_id uuid, p_score integer, p_comment text default null)
returns public.ratings
language plpgsql security definer set search_path = public
as $$
declare r public.service_requests; result public.ratings; target uuid;
begin
  select * into r from public.service_requests where id = p_request_id
    and (customer_id = auth.uid() or technician_id = auth.uid());
  if r.id is null or r.technician_id is null or r.status not in ('completed', 'no_agreement')
  then raise exception 'لا يمكن تقييم هذا الطلب'; end if;
  target := case when r.customer_id = auth.uid() then r.technician_id else r.customer_id end;
  insert into public.ratings(request_id, rater_id, ratee_id, score, comment)
  values (r.id, auth.uid(), target, p_score, nullif(p_comment, ''))
  returning * into result;
  return result;
exception when unique_violation then
  raise exception 'تم إرسال التقييم مسبقًا';
end;
$$;

create or replace function public.get_request_contact(p_request_id uuid)
returns json
language sql security definer set search_path = public
as $$
  select json_build_object(
    'customer', json_build_object('full_name', cp.full_name, 'phone', cp.phone),
    'technician', json_build_object('full_name', tp.full_name, 'phone', tp.phone)
  )
  from public.service_requests r
  join public.profiles cp on cp.id = r.customer_id
  join public.profiles tp on tp.id = r.technician_id
  where r.id = p_request_id
    and r.contact_unlocked
    and (r.customer_id = auth.uid() or r.technician_id = auth.uid() or public.is_admin());
$$;

create or replace function public.review_topup_receipt(p_receipt_id uuid, p_status text)
returns public.topup_receipts
language plpgsql security definer set search_path = public
as $$
declare receipt public.topup_receipts;
begin
  if not public.is_admin() or p_status not in ('approved', 'rejected') then raise exception 'غير مصرح'; end if;
  select * into receipt from public.topup_receipts where id = p_receipt_id for update;
  if receipt.id is null or receipt.status <> 'pending' then raise exception 'الإيصال غير متاح للمراجعة'; end if;
  update public.topup_receipts set status = p_status, reviewed_by = auth.uid(), reviewed_at = now()
    where id = receipt.id returning * into receipt;
  if p_status = 'approved' then
    update public.profiles set balance = balance + receipt.amount where id = receipt.technician_id;
  end if;
  return receipt;
end;
$$;

revoke execute on function public.is_admin() from public;
revoke execute on function public.claim_request(uuid) from public;
revoke execute on function public.update_request_status(uuid, text) from public;
revoke execute on function public.submit_rating(uuid, integer, text) from public;
revoke execute on function public.get_request_contact(uuid) from public;
revoke execute on function public.review_topup_receipt(uuid, text) from public;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.claim_request(uuid) to authenticated;
grant execute on function public.update_request_status(uuid, text) to authenticated;
grant execute on function public.submit_rating(uuid, integer, text) to authenticated;
grant execute on function public.get_request_contact(uuid) to authenticated;
grant execute on function public.review_topup_receipt(uuid, text) to authenticated;

insert into storage.buckets (id, name, public)
values ('request-images', 'request-images', true), ('topup-receipts', 'topup-receipts', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists request_images_upload on storage.objects;
create policy request_images_upload on storage.objects for insert to authenticated
with check (bucket_id = 'request-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists topup_receipts_upload on storage.objects;
create policy topup_receipts_upload on storage.objects for insert to authenticated
with check (bucket_id = 'topup-receipts' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists own_files_delete on storage.objects;
create policy own_files_delete on storage.objects for delete to authenticated
using ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin());
drop policy if exists admin_receipts_read on storage.objects;
create policy admin_receipts_read on storage.objects for select to authenticated
using (bucket_id in ('request-images', 'topup-receipts') and (storage.foldername(name))[1] = auth.uid()::text or public.is_admin());
