-- =============================================================================
-- Premium leadgen — loyalty + referrals
-- Migration: 20260507000004_loyalty_referrals.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Поля у contacts: лояльность и счётчики
-- -----------------------------------------------------------------------------
alter table public.contacts
  add column if not exists loyalty_tier  text not null default 'standard',
  add column if not exists total_orders  int  not null default 0,
  add column if not exists last_order_at timestamptz;

comment on column public.contacts.loyalty_tier
  is 'Тариф лояльности (на будущее: vip, partner, ...). На UX пока не влияет.';
comment on column public.contacts.total_orders
  is 'Кол-во выполненных заказов (status=done). Обновляется триггером.';

-- -----------------------------------------------------------------------------
-- 2. Поля у leads: скидки и связи
-- -----------------------------------------------------------------------------
alter table public.leads
  add column if not exists discount_percent int  not null default 0,
  add column if not exists discount_rub     int  not null default 0,
  add column if not exists repeat_of        uuid references public.leads(id) on delete set null,
  add column if not exists referral_id      uuid;

create index if not exists idx_leads_repeat_of on public.leads(repeat_of);

-- -----------------------------------------------------------------------------
-- 3. Реферальные коды (1-к-1 с contact)
-- -----------------------------------------------------------------------------
create table if not exists public.referral_codes (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null unique references public.contacts(id) on delete cascade,
  code        text not null unique,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table public.referral_codes is 'Реферальный код контакта. Один контакт — один код.';

-- -----------------------------------------------------------------------------
-- 4. Реферальные связи
-- -----------------------------------------------------------------------------
do $$ begin
  create type referral_status as enum ('pending','qualified','expired');
exception when duplicate_object then null;
end $$;

create table if not exists public.referrals (
  id                     uuid primary key default gen_random_uuid(),
  referrer_contact_id    uuid not null references public.contacts(id) on delete cascade,
  invitee_contact_id     uuid not null references public.contacts(id) on delete cascade,
  referral_code_id       uuid not null references public.referral_codes(id),
  qualifying_lead_id     uuid references public.leads(id) on delete set null,
  status                 referral_status not null default 'pending',
  created_at             timestamptz not null default now(),
  qualified_at           timestamptz,
  unique (invitee_contact_id),                  -- один invitee может быть приглашён только однажды
  check (referrer_contact_id <> invitee_contact_id)
);
comment on table public.referrals is 'Связи: кто кого пригласил. invitee уникален — anti-self-invite + first-touch wins.';

create index if not exists idx_referrals_referrer on public.referrals(referrer_contact_id, status);

alter table public.leads
  drop constraint if exists leads_referral_fk;
alter table public.leads
  add constraint leads_referral_fk foreign key (referral_id) references public.referrals(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 5. Балансы и события лояльности
-- -----------------------------------------------------------------------------
create table if not exists public.loyalty_balances (
  contact_id  uuid primary key references public.contacts(id) on delete cascade,
  bonus_rub   int not null default 0,
  updated_at  timestamptz not null default now(),
  check (bonus_rub >= 0)
);
comment on table public.loyalty_balances is 'Текущий бонусный баланс контакта в рублях.';

create table if not exists public.loyalty_events (
  id                 bigserial primary key,
  contact_id         uuid not null references public.contacts(id) on delete cascade,
  delta_rub          int  not null,
  reason             text not null,        -- 'referral_qualified' | 'order_applied' | 'refund' | 'expired' | 'manual'
  related_lead_id    uuid references public.leads(id) on delete set null,
  related_referral_id uuid references public.referrals(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_loyalty_events_contact on public.loyalty_events(contact_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 6. RPC: ensure_referral_code
-- -----------------------------------------------------------------------------
create or replace function public.ensure_referral_code(p_contact_id uuid)
returns text language plpgsql security definer as $$
declare v_code text;
begin
  select code into v_code from public.referral_codes where contact_id = p_contact_id;
  if v_code is not null then return v_code; end if;

  for i in 1..5 loop
    v_code := upper(substring(md5(gen_random_uuid()::text) for 6));
    begin
      insert into public.referral_codes (contact_id, code) values (p_contact_id, v_code);
      return v_code;
    exception when unique_violation then
      continue;
    end;
  end loop;
  raise exception 'failed to generate unique referral code';
end $$;

-- -----------------------------------------------------------------------------
-- 7. RPC: record_referral_visit (на /start ref_<code>)
-- -----------------------------------------------------------------------------
create or replace function public.record_referral_visit(
  p_invitee_contact_id uuid,
  p_code text
) returns uuid language plpgsql security definer as $$
declare v_rc record; v_id uuid;
begin
  select * into v_rc from public.referral_codes where code = p_code and is_active;
  if v_rc.id is null then return null; end if;
  if v_rc.contact_id = p_invitee_contact_id then return null; end if;  -- self-invite

  insert into public.referrals (referrer_contact_id, invitee_contact_id, referral_code_id, status)
  values (v_rc.contact_id, p_invitee_contact_id, v_rc.id, 'pending')
  on conflict (invitee_contact_id) do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.events (type, contact_id, payload)
    values ('referral.visit', p_invitee_contact_id, jsonb_build_object('referrer_contact_id', v_rc.contact_id, 'code', p_code));
  end if;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- 8. RPC: grant_bonus / spend_bonus
-- -----------------------------------------------------------------------------
create or replace function public.grant_bonus(
  p_contact_id uuid,
  p_amount int,
  p_reason text,
  p_lead_id uuid default null,
  p_ref_id uuid default null
) returns void language plpgsql security definer as $$
begin
  if p_amount <= 0 then return; end if;

  insert into public.loyalty_balances (contact_id, bonus_rub) values (p_contact_id, p_amount)
  on conflict (contact_id) do update
    set bonus_rub = public.loyalty_balances.bonus_rub + excluded.bonus_rub,
        updated_at = now();

  insert into public.loyalty_events (contact_id, delta_rub, reason, related_lead_id, related_referral_id)
  values (p_contact_id, p_amount, p_reason, p_lead_id, p_ref_id);

  insert into public.events (type, contact_id, lead_id, payload)
  values ('loyalty.bonus_granted', p_contact_id, p_lead_id,
          jsonb_build_object('amount', p_amount, 'reason', p_reason));
end $$;

create or replace function public.spend_bonus(
  p_contact_id uuid,
  p_amount int,
  p_lead_id uuid
) returns int language plpgsql security definer as $$
declare v_balance int; v_used int;
begin
  if p_amount <= 0 then return 0; end if;

  select bonus_rub into v_balance
    from public.loyalty_balances
   where contact_id = p_contact_id
   for update;

  v_balance := coalesce(v_balance, 0);
  if v_balance <= 0 then return 0; end if;

  v_used := least(v_balance, p_amount);

  update public.loyalty_balances
     set bonus_rub = bonus_rub - v_used,
         updated_at = now()
   where contact_id = p_contact_id;

  insert into public.loyalty_events (contact_id, delta_rub, reason, related_lead_id)
  values (p_contact_id, -v_used, 'order_applied', p_lead_id);

  return v_used;
end $$;

-- -----------------------------------------------------------------------------
-- 9. RPC: refund_bonus — если заказ отменён
-- -----------------------------------------------------------------------------
create or replace function public.refund_bonus(p_lead_id uuid)
returns void language plpgsql security definer as $$
declare v_used int; v_contact uuid;
begin
  select sum(-delta_rub), max(contact_id) into v_used, v_contact
    from public.loyalty_events
   where related_lead_id = p_lead_id and reason = 'order_applied';

  if v_used is null or v_used <= 0 or v_contact is null then return; end if;

  update public.loyalty_balances
     set bonus_rub = bonus_rub + v_used, updated_at = now()
   where contact_id = v_contact;

  insert into public.loyalty_events (contact_id, delta_rub, reason, related_lead_id)
  values (v_contact, v_used, 'refund', p_lead_id);
end $$;

-- -----------------------------------------------------------------------------
-- 10. RPC: compute_discount_for_contact
--   Возвращает potential percent + потенциально доступный bonus_rub
--   (по балансу, без капа — кап применяется в Vercel при списании, типично 500)
-- -----------------------------------------------------------------------------
create or replace function public.compute_discount_for_contact(
  p_contact_id uuid,
  p_service_kind service_kind
) returns table (percent int, rub_bonus int)
language plpgsql stable as $$
declare v_orders int; v_balance int;
begin
  select count(*) into v_orders
    from public.leads l
   where l.contact_id = p_contact_id
     and l.status = 'done'
     and l.completed_at is not null
     and l.completed_at >= date_trunc('year', now());

  select bonus_rub into v_balance from public.loyalty_balances where contact_id = p_contact_id;
  v_balance := coalesce(v_balance, 0);

  if v_orders >= 2 then
    percent := 10;
  elsif v_orders = 1 then
    percent := 5;
  else
    percent := 0;
  end if;
  rub_bonus := v_balance;
  return next;
end $$;

-- -----------------------------------------------------------------------------
-- 11. Триггер: bump_total_orders при переходе lead.status='done'
-- -----------------------------------------------------------------------------
create or replace function public.tg_bump_total_orders()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done') then
    update public.contacts
       set total_orders  = total_orders + 1,
           last_order_at = coalesce(new.completed_at, now())
     where id = new.contact_id;
  end if;
  return new;
end $$;

drop trigger if exists bump_total_orders on public.leads;
create trigger bump_total_orders after update on public.leads
  for each row execute function public.tg_bump_total_orders();

-- -----------------------------------------------------------------------------
-- 12. Триггер: при первом done у invitee — qualify_referral автоматически
-- -----------------------------------------------------------------------------
create or replace function public.tg_qualify_referral_on_done()
returns trigger language plpgsql as $$
declare v_first_done boolean;
begin
  if (tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done') then
    -- проверяем, есть ли pending-реферал у invitee
    perform 1 from public.referrals
      where invitee_contact_id = new.contact_id and status = 'pending';
    if found then
      -- проверяем, что это первый done у invitee
      select count(*) = 0 into v_first_done
        from public.leads
       where contact_id = new.contact_id
         and status = 'done'
         and id <> new.id
         and completed_at is not null;
      if v_first_done then
        perform public.qualify_referral(new.contact_id, new.id, 500);
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists qualify_referral_on_done on public.leads;
create trigger qualify_referral_on_done after update on public.leads
  for each row execute function public.tg_qualify_referral_on_done();

-- -----------------------------------------------------------------------------
-- 13. RPC: qualify_referral (если нужно дёрнуть руками или из n8n)
-- -----------------------------------------------------------------------------
create or replace function public.qualify_referral(
  p_invitee_contact_id uuid,
  p_lead_id uuid,
  p_bonus_rub int default 500
) returns void language plpgsql security definer as $$
declare v_ref record;
begin
  select * into v_ref from public.referrals
   where invitee_contact_id = p_invitee_contact_id and status = 'pending'
   for update;

  if v_ref.id is null then return; end if;

  update public.referrals
     set status = 'qualified',
         qualified_at = now(),
         qualifying_lead_id = p_lead_id
   where id = v_ref.id;

  perform public.grant_bonus(v_ref.referrer_contact_id, p_bonus_rub, 'referral_qualified', null, v_ref.id);
  perform public.grant_bonus(v_ref.invitee_contact_id,  p_bonus_rub, 'referral_qualified', null, v_ref.id);

  insert into public.events (type, contact_id, lead_id, payload)
  values ('referral.qualified', v_ref.referrer_contact_id, p_lead_id,
          jsonb_build_object('invitee_contact_id', p_invitee_contact_id, 'bonus_rub', p_bonus_rub));
end $$;

-- -----------------------------------------------------------------------------
-- 14. View: v_my_orders (для бота "Мои заказы")
-- -----------------------------------------------------------------------------
create or replace view public.v_my_orders as
select
  l.id,
  l.contact_id,
  'A-' || lpad((100 + (extract(epoch from l.created_at)::bigint % 9000))::text, 4, '0') as human_id,
  l.service_kind,
  s.name as service_name,
  s.short_name as service_short,
  l.status::text,
  l.area_value, l.area_unit, l.district,
  l.desired_date_from, l.desired_date_to, l.scheduled_at,
  l.price_quoted, l.price_final,
  l.discount_percent, l.discount_rub,
  l.repeat_of,
  l.created_at, l.last_activity_at
from public.leads l
join public.services s on s.id = l.service_id
where l.deleted_at is null;

-- -----------------------------------------------------------------------------
-- 15. View: v_my_referrals (для экрана "Мои рефералы")
-- -----------------------------------------------------------------------------
create or replace view public.v_my_referrals as
select
  r.id,
  r.referrer_contact_id,
  r.invitee_contact_id,
  inv.full_name as invitee_name,
  r.status::text,
  r.created_at,
  r.qualified_at
from public.referrals r
join public.contacts inv on inv.id = r.invitee_contact_id
where inv.deleted_at is null;

-- -----------------------------------------------------------------------------
-- 16. RLS на новые таблицы (service_role обходит)
-- -----------------------------------------------------------------------------
alter table public.referral_codes  enable row level security;
alter table public.referrals       enable row level security;
alter table public.loyalty_balances enable row level security;
alter table public.loyalty_events  enable row level security;
