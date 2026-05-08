-- Multi-region support: Omsk + Novosibirsk
-- Adds region enum, regions lookup, region columns on core tables,
-- regional price tables, helper RPCs, and updates views.

do $$ begin
  create type region as enum ('omsk','novosibirsk');
exception when duplicate_object then null;
end $$;

create table if not exists public.regions (
  code        region primary key,
  name        text not null,
  city        text not null,
  timezone    text not null,
  phone_code  text not null default '+7',
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.regions is 'Регионы присутствия (Омск, Новосибирск). Используется для роутинга заявок, рассылок и цен.';

insert into public.regions (code, name, city, timezone, phone_code, sort_order) values
  ('omsk',        'Омск',         'Омск',         'Asia/Omsk',         '+7', 1),
  ('novosibirsk', 'Новосибирск',  'Новосибирск',  'Asia/Novosibirsk',  '+7', 2)
on conflict (code) do nothing;

drop trigger if exists set_updated_at on public.regions;
create trigger set_updated_at before update on public.regions
  for each row execute function public.tg_set_updated_at();

alter table public.contacts        add column if not exists region region;
alter table public.bot_sessions    add column if not exists region region;
alter table public.leads           add column if not exists region region;
alter table public.material_orders add column if not exists region region;
alter table public.subscriptions   add column if not exists region region;
alter table public.campaigns       add column if not exists region region;
alter table public.traffic_sources add column if not exists region region;

update public.material_orders set region = 'omsk' where region is null;
alter table public.material_orders alter column city drop default;

create index if not exists idx_contacts_region        on public.contacts(region);
create index if not exists idx_leads_region           on public.leads(region);
create index if not exists idx_material_orders_region on public.material_orders(region);
create index if not exists idx_subscriptions_region   on public.subscriptions(region);
create index if not exists idx_campaigns_region       on public.campaigns(region);
create index if not exists idx_traffic_sources_region on public.traffic_sources(region);

create table if not exists public.service_region_prices (
  service_id  uuid not null references public.services(id) on delete cascade,
  region      region not null,
  price_min   numeric(12,2),
  price_max   numeric(12,2),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (service_id, region)
);
comment on table public.service_region_prices is 'Региональные цены на услуги (Омск/Новосибирск).';

create table if not exists public.material_grade_region_prices (
  grade_id    uuid not null references public.material_grades(id) on delete cascade,
  region      region not null,
  price_min   numeric(12,2),
  price_max   numeric(12,2),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (grade_id, region)
);
comment on table public.material_grade_region_prices is 'Региональные цены на марки материалов.';

drop trigger if exists set_updated_at on public.service_region_prices;
create trigger set_updated_at before update on public.service_region_prices
  for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.material_grade_region_prices;
create trigger set_updated_at before update on public.material_grade_region_prices
  for each row execute function public.tg_set_updated_at();

create or replace function public.fn_resolve_region(p_contact uuid)
returns region
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select c.region from public.contacts c where c.id = p_contact),
    (select bs.region
       from public.bot_sessions bs
       join public.contact_identities ci on ci.id = bs.identity_id
      where ci.contact_id = p_contact and bs.region is not null
      order by bs.updated_at desc
      limit 1),
    'omsk'::region
  );
$$;

create or replace function public.rpc_set_contact_region(
  p_contact uuid,
  p_region  region
) returns region
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.contacts
     set region = p_region,
         updated_at = now()
   where id = p_contact;

  update public.bot_sessions
     set region = p_region,
         updated_at = now()
   where identity_id in (
     select id from public.contact_identities where contact_id = p_contact
   );

  return p_region;
end $$;

revoke all on function public.rpc_set_contact_region(uuid, region) from public, anon, authenticated;
grant  execute on function public.rpc_set_contact_region(uuid, region) to service_role;
revoke all on function public.fn_resolve_region(uuid)              from public, anon, authenticated;
grant  execute on function public.fn_resolve_region(uuid)               to service_role;

do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'traffic_sources_code_key' and conrelid = 'public.traffic_sources'::regclass
  ) then
    alter table public.traffic_sources drop constraint traffic_sources_code_key;
  end if;
end $$;

create unique index if not exists ux_traffic_sources_code_region
  on public.traffic_sources (code, region) nulls not distinct;

drop view if exists public.v_my_orders cascade;
create view public.v_my_orders
with (security_invoker = true)
as
select
  l.id,
  l.contact_id,
  l.service_id,
  s.short_name      as service_name,
  s.kind            as service_kind,
  l.status,
  l.region,
  l.district,
  l.address,
  l.desired_date_from,
  l.desired_date_to,
  l.scheduled_at,
  l.completed_at,
  l.price_final,
  l.created_at
from public.leads l
left join public.services s on s.id = l.service_id
where l.deleted_at is null;
comment on view public.v_my_orders is 'История заявок клиента (для бота: «Мои заказы»). Включает регион.';

drop view if exists public.v_active_leads cascade;
create view public.v_active_leads
with (security_invoker = true)
as
select
  l.id,
  l.contact_id,
  l.service_id,
  s.short_name as service_name,
  s.kind       as service_kind,
  l.status,
  l.region,
  l.district,
  l.address,
  l.desired_date_from,
  l.desired_date_to,
  l.scheduled_at,
  l.created_at,
  l.last_activity_at
from public.leads l
left join public.services s on s.id = l.service_id
where l.status not in ('done','lost','archived')
  and l.deleted_at is null;
comment on view public.v_active_leads is 'Активные заявки (kanban / обработка операторами). Включает регион.';
