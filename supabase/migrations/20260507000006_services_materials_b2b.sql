-- =============================================================================
-- Premium leadgen — расширение: новые услуги, материалы, B2C/B2B, подписки
-- Migration: 20260507000006_services_materials_b2b.sql
-- =============================================================================

-- 1. Расширяем service_kind новыми значениями.
--    NB: alter type ... add value не работает в транзакции до commit,
--    поэтому каждое addvalue выполняем отдельно.
do $$ begin
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid=t.oid
                 where t.typname='service_kind' and e.enumlabel='weed_removal') then
    alter type service_kind add value 'weed_removal';
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid=t.oid
                 where t.typname='service_kind' and e.enumlabel='pool_maintenance') then
    alter type service_kind add value 'pool_maintenance';
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid=t.oid
                 where t.typname='service_kind' and e.enumlabel='welding') then
    alter type service_kind add value 'welding';
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid=t.oid
                 where t.typname='service_kind' and e.enumlabel='tilling') then
    alter type service_kind add value 'tilling';
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid=t.oid
                 where t.typname='service_kind' and e.enumlabel='subscription') then
    alter type service_kind add value 'subscription';
  end if;
end $$;

-- 2. customer_type и реквизиты в contacts.
do $$ begin
  create type customer_type as enum ('b2c','b2b');
exception when duplicate_object then null;
end $$;

alter table public.contacts
  add column if not exists customer_type customer_type,
  add column if not exists company_name  text,
  add column if not exists company_inn   text,
  add column if not exists company_kpp   text,
  add column if not exists company_address text;

create index if not exists idx_contacts_customer_type on public.contacts(customer_type);

-- 3. Материалы (справочник)
do $$ begin
  create type material_kind as enum ('concrete','crushed_stone','sand','cement','brick');
exception when duplicate_object then null;
end $$;

create table if not exists public.materials (
  id          uuid primary key default gen_random_uuid(),
  kind        material_kind not null unique,
  name        text not null,
  short_name  text not null,
  description text,
  unit        text not null,                  -- 'м3' | 'тонна' | 'шт' | 'мешок' | 'поддон'
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.materials is 'Справочник типов стройматериалов.';

create table if not exists public.material_grades (
  id          uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.materials(id) on delete cascade,
  code        text not null,                   -- 'M200','5-20','karyer','M500_25','obl'
  name        text not null,                   -- 'M200', '5–20 мм гранитный', ...
  unit        text not null,                   -- м3 | тонна | шт | мешок | поддон
  price_min   numeric(12,2),
  price_max   numeric(12,2),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (material_id, code)
);
create index if not exists idx_material_grades_material on public.material_grades(material_id);

drop trigger if exists set_updated_at on public.materials;
create trigger set_updated_at before update on public.materials
  for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.material_grades;
create trigger set_updated_at before update on public.material_grades
  for each row execute function public.tg_set_updated_at();

-- 4. material_orders — заказы материалов
do $$ begin
  create type material_order_status as enum (
    'new','qualifying','quoted','scheduled','delivering','delivered','done','lost','archived'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.material_orders (
  id                 uuid primary key default gen_random_uuid(),
  contact_id         uuid not null references public.contacts(id) on delete cascade,
  customer_type      customer_type,
  channel            messenger_channel not null,
  source_id          uuid references public.traffic_sources(id) on delete set null,

  material_id        uuid not null references public.materials(id),
  material_kind      material_kind not null,
  grade_id           uuid references public.material_grades(id),
  grade_code         text,
  grade_name         text,

  quantity           numeric(12,3) not null,
  unit               text not null,

  needs_pump         boolean not null default false,
  needs_manipulator  boolean not null default false,
  delivery_only      boolean not null default false, -- только разгрузка с борта
  delivery_address   text,
  district           text,
  city               text default 'Омск',

  desired_date_from  date,
  desired_date_to    date,
  scheduled_at       timestamptz,
  delivered_at       timestamptz,
  completed_at       timestamptz,

  status             material_order_status not null default 'new',
  price_quoted       numeric(12,2),
  price_final        numeric(12,2),
  currency           text not null default 'RUB',

  discount_percent   int  not null default 0,
  discount_rub       int  not null default 0,
  repeat_of          uuid references public.material_orders(id) on delete set null,
  referral_id        uuid references public.referrals(id) on delete set null,

  metadata           jsonb not null default '{}'::jsonb,
  last_activity_at   timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
comment on table public.material_orders is 'Заказы материалов (бетон, щебень, песок, цемент, кирпич).';

create index if not exists idx_material_orders_contact      on public.material_orders(contact_id);
create index if not exists idx_material_orders_kind         on public.material_orders(material_kind);
create index if not exists idx_material_orders_status       on public.material_orders(status);
create index if not exists idx_material_orders_completed    on public.material_orders(completed_at desc) where completed_at is not null;
create index if not exists idx_material_orders_repeat_of    on public.material_orders(repeat_of);
create index if not exists idx_material_orders_deleted      on public.material_orders(deleted_at) where deleted_at is null;

drop trigger if exists set_updated_at on public.material_orders;
create trigger set_updated_at before update on public.material_orders
  for each row execute function public.tg_set_updated_at();

-- 5. Подписки (абонентское обслуживание)
do $$ begin
  create type subscription_status as enum ('active','paused','cancelled','expired');
exception when duplicate_object then null;
end $$;
do $$ begin
  create type subscription_kind as enum ('garden_basic','garden_comfort','garden_premium','custom');
exception when duplicate_object then null;
end $$;

create table if not exists public.subscriptions (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references public.contacts(id) on delete cascade,
  kind            subscription_kind not null,
  channel         messenger_channel,
  starts_on       date not null default current_date,
  ends_on         date,
  frequency       text not null default 'biweekly', -- weekly | biweekly | monthly | custom
  price_per_month numeric(12,2),
  status          subscription_status not null default 'active',
  district        text,
  address         text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.subscriptions is 'Абонентское обслуживание: договор на сезон. Каждый визит мастера — отдельный lead с metadata.subscription_id.';

create index if not exists idx_subscriptions_contact on public.subscriptions(contact_id);
create index if not exists idx_subscriptions_status  on public.subscriptions(status);

drop trigger if exists set_updated_at on public.subscriptions;
create trigger set_updated_at before update on public.subscriptions
  for each row execute function public.tg_set_updated_at();

-- 6. Сервисные RPC

-- 6.1. set_customer_type
create or replace function public.set_customer_type(
  p_contact_id   uuid,
  p_customer_type customer_type
) returns void language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  update public.contacts set customer_type = p_customer_type, updated_at = now()
   where id = p_contact_id;

  insert into public.events (type, contact_id, payload)
  values ('contact.customer_type_set', p_contact_id, jsonb_build_object('customer_type', p_customer_type));
end $$;

revoke execute on function public.set_customer_type(uuid, customer_type) from public, anon, authenticated;
grant  execute on function public.set_customer_type(uuid, customer_type) to   service_role;

-- 6.2. create_material_order
create or replace function public.create_material_order(
  p_contact_id      uuid,
  p_material_kind   material_kind,
  p_grade_code      text,
  p_quantity        numeric,
  p_unit            text,
  p_channel         messenger_channel,
  p_district        text default null,
  p_address         text default null,
  p_needs_pump      boolean default false,
  p_needs_manipulator boolean default false,
  p_delivery_only   boolean default false,
  p_metadata        jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_material_id uuid;
  v_grade_id    uuid;
  v_grade_name  text;
  v_order_id    uuid;
  v_customer_type customer_type;
begin
  select id into v_material_id from public.materials where kind = p_material_kind;
  if v_material_id is null then
    raise exception 'material_kind % not found', p_material_kind;
  end if;
  if p_grade_code is not null then
    select id, name into v_grade_id, v_grade_name
      from public.material_grades
     where material_id = v_material_id and code = p_grade_code;
  end if;

  select customer_type into v_customer_type from public.contacts where id = p_contact_id;

  insert into public.material_orders (
    contact_id, customer_type, channel,
    material_id, material_kind, grade_id, grade_code, grade_name,
    quantity, unit,
    needs_pump, needs_manipulator, delivery_only,
    delivery_address, district,
    metadata
  ) values (
    p_contact_id, v_customer_type, p_channel,
    v_material_id, p_material_kind, v_grade_id, p_grade_code, v_grade_name,
    p_quantity, p_unit,
    p_needs_pump, p_needs_manipulator, p_delivery_only,
    p_address, p_district,
    p_metadata
  ) returning id into v_order_id;

  insert into public.events (type, contact_id, channel, payload)
  values ('material_order.created', p_contact_id, p_channel,
          jsonb_build_object('order_id', v_order_id, 'material_kind', p_material_kind,
                             'grade_code', p_grade_code, 'quantity', p_quantity, 'unit', p_unit));

  return v_order_id;
end $$;

revoke execute on function public.create_material_order(uuid, material_kind, text, numeric, text, messenger_channel, text, text, boolean, boolean, boolean, jsonb) from public, anon, authenticated;
grant  execute on function public.create_material_order(uuid, material_kind, text, numeric, text, messenger_channel, text, text, boolean, boolean, boolean, jsonb) to   service_role;

-- 6.3. set_material_order_status
create or replace function public.set_material_order_status(
  p_order_id uuid,
  p_status   material_order_status,
  p_actor    text default 'system'
) returns void language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_old material_order_status;
begin
  select status into v_old from public.material_orders where id = p_order_id for update;
  if v_old is null then raise exception 'material_order % not found', p_order_id; end if;
  if v_old = p_status then return; end if;

  update public.material_orders set status = p_status, updated_at = now()
   where id = p_order_id;

  insert into public.events (type, payload)
  values ('material_order.status_changed',
          jsonb_build_object('order_id', p_order_id, 'from', v_old, 'to', p_status, 'actor', p_actor));
end $$;

revoke execute on function public.set_material_order_status(uuid, material_order_status, text) from public, anon, authenticated;
grant  execute on function public.set_material_order_status(uuid, material_order_status, text) to   service_role;

-- 6.4. compute_discount_unified — версия, которая считает "completed" по обоим источникам
create or replace function public.compute_discount_unified(
  p_contact_id uuid
) returns table (percent int, rub_bonus int, total_done int)
language plpgsql stable
set search_path = public, pg_temp as $$
declare v_orders int; v_balance int;
begin
  select
    (select count(*)
       from public.leads l
      where l.contact_id = p_contact_id
        and l.status = 'done'
        and l.completed_at is not null
        and l.completed_at >= date_trunc('year', now()))
    +
    (select count(*)
       from public.material_orders mo
      where mo.contact_id = p_contact_id
        and mo.status = 'done'
        and mo.completed_at is not null
        and mo.completed_at >= date_trunc('year', now()))
   into v_orders;

  select bonus_rub into v_balance from public.loyalty_balances where contact_id = p_contact_id;
  v_balance := coalesce(v_balance, 0);

  if v_orders >= 2 then percent := 10;
  elsif v_orders = 1 then percent := 5;
  else percent := 0; end if;

  rub_bonus := v_balance;
  total_done := v_orders;
  return next;
end $$;

revoke execute on function public.compute_discount_unified(uuid) from public, anon, authenticated;
grant  execute on function public.compute_discount_unified(uuid) to   service_role;

-- 6.5. триггеры — bump_total_orders теперь смотрит и в material_orders
create or replace function public.tg_bump_total_orders_material()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if (tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done') then
    update public.contacts
       set total_orders  = total_orders + 1,
           last_order_at = coalesce(new.completed_at, now())
     where id = new.contact_id;
  end if;
  return new;
end $$;

drop trigger if exists bump_total_orders on public.material_orders;
create trigger bump_total_orders after update on public.material_orders
  for each row execute function public.tg_bump_total_orders_material();

-- 6.6. qualify_referral срабатывает и при первом done материала
create or replace function public.tg_qualify_referral_on_material_done()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare v_first_done boolean;
begin
  if (tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done') then
    perform 1 from public.referrals
      where invitee_contact_id = new.contact_id and status = 'pending';
    if found then
      select (
        (select count(*) from public.leads
            where contact_id = new.contact_id and status = 'done' and completed_at is not null) = 0
        and
        (select count(*) from public.material_orders
            where contact_id = new.contact_id and status = 'done'
              and id <> new.id and completed_at is not null) = 0
      ) into v_first_done;
      if v_first_done then
        perform public.qualify_referral(new.contact_id, null, 500);
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists qualify_referral_on_material_done on public.material_orders;
create trigger qualify_referral_on_material_done after update on public.material_orders
  for each row execute function public.tg_qualify_referral_on_material_done();

-- 7. View v_my_all_orders — единый список заказов клиента
create or replace view public.v_my_all_orders as
select
  l.id,
  l.contact_id,
  'service'::text                                        as category,
  l.service_kind::text                                   as kind_code,
  s.name                                                 as kind_name,
  'A-' || lpad((100 + (extract(epoch from l.created_at)::bigint % 9000))::text, 4, '0') as human_id,
  l.status::text                                         as status,
  null::numeric                                          as quantity,
  l.area_value                                           as area_value,
  l.area_unit                                            as area_unit,
  l.district                                             as district,
  l.desired_date_from, l.desired_date_to, l.scheduled_at,
  l.price_quoted, l.price_final,
  l.discount_percent, l.discount_rub,
  l.repeat_of,
  l.created_at, l.last_activity_at
from public.leads l
join public.services s on s.id = l.service_id
where l.deleted_at is null

union all

select
  mo.id,
  mo.contact_id,
  'material'::text                                       as category,
  mo.material_kind::text                                 as kind_code,
  m.name                                                 as kind_name,
  'M-' || lpad((100 + (extract(epoch from mo.created_at)::bigint % 9000))::text, 4, '0') as human_id,
  mo.status::text                                        as status,
  mo.quantity                                            as quantity,
  null::numeric                                          as area_value,
  mo.unit                                                as area_unit,
  mo.district                                            as district,
  mo.desired_date_from, mo.desired_date_to, mo.scheduled_at,
  mo.price_quoted, mo.price_final,
  mo.discount_percent, mo.discount_rub,
  mo.repeat_of,
  mo.created_at, mo.last_activity_at
from public.material_orders mo
join public.materials m on m.id = mo.material_id
where mo.deleted_at is null;

alter view public.v_my_all_orders set (security_invoker = true);

-- 8. RLS на новые таблицы
alter table public.materials         enable row level security;
alter table public.material_grades   enable row level security;
alter table public.material_orders   enable row level security;
alter table public.subscriptions     enable row level security;

-- Anon видит активный справочник материалов и марок (для будущей витрины)
drop policy if exists "anon read materials" on public.materials;
create policy "anon read materials" on public.materials
  for select using (is_active = true);

drop policy if exists "anon read material_grades" on public.material_grades;
create policy "anon read material_grades" on public.material_grades
  for select using (is_active = true);
