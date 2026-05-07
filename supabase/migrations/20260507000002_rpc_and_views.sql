-- =============================================================================
-- Premium leadgen — RPC и views для n8n / Vercel
-- Migration: 20260507000002_rpc_and_views.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- RPC: upsert_contact_by_identity
--   Используется обработчиками вебхуков (Vercel) и n8n при первом контакте.
--   Возвращает (contact_id, identity_id, is_new).
-- -----------------------------------------------------------------------------
create or replace function public.upsert_contact_by_identity(
  p_channel       messenger_channel,
  p_external_id   text,
  p_username      text default null,
  p_display_name  text default null,
  p_full_name     text default null,
  p_phone         text default null,
  p_source_code   text default null
) returns table (contact_id uuid, identity_id uuid, is_new boolean)
language plpgsql security definer as $$
declare
  v_identity_id uuid;
  v_contact_id  uuid;
  v_source_id   uuid;
  v_is_new      boolean := false;
begin
  if p_source_code is not null then
    select id into v_source_id from public.traffic_sources where code = p_source_code;
  end if;

  select ci.id, ci.contact_id into v_identity_id, v_contact_id
    from public.contact_identities ci
   where ci.channel = p_channel and ci.external_id = p_external_id;

  if v_identity_id is null then
    insert into public.contacts (full_name, phone, source_id, preferred_channel)
    values (coalesce(p_full_name, p_display_name), p_phone, v_source_id, p_channel)
    returning id into v_contact_id;

    insert into public.contact_identities (contact_id, channel, external_id, username, display_name)
    values (v_contact_id, p_channel, p_external_id, p_username, p_display_name)
    returning id into v_identity_id;

    v_is_new := true;
  else
    update public.contact_identities
       set username     = coalesce(p_username, username),
           display_name = coalesce(p_display_name, display_name),
           updated_at   = now()
     where id = v_identity_id;

    if p_phone is not null then
      update public.contacts set phone = p_phone where id = v_contact_id and phone is null;
    end if;
  end if;

  return query select v_contact_id, v_identity_id, v_is_new;
end $$;

-- -----------------------------------------------------------------------------
-- RPC: create_lead
--   Создаёт заявку и пишет событие 'lead.created' (его слушает n8n).
-- -----------------------------------------------------------------------------
create or replace function public.create_lead(
  p_contact_id    uuid,
  p_service_kind  service_kind,
  p_channel       messenger_channel,
  p_description   text default null,
  p_area_value    numeric default null,
  p_area_unit     text default null,
  p_district      text default null,
  p_address       text default null,
  p_metadata      jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer as $$
declare
  v_service_id uuid;
  v_lead_id    uuid;
begin
  select id into v_service_id from public.services where kind = p_service_kind;
  if v_service_id is null then
    raise exception 'service_kind % not found', p_service_kind;
  end if;

  insert into public.leads (
    contact_id, service_id, service_kind, channel,
    description, area_value, area_unit, district, address, metadata
  ) values (
    p_contact_id, v_service_id, p_service_kind, p_channel,
    p_description, p_area_value, p_area_unit, p_district, p_address, p_metadata
  ) returning id into v_lead_id;

  insert into public.events (type, contact_id, lead_id, channel, payload)
  values ('lead.created', p_contact_id, v_lead_id, p_channel,
          jsonb_build_object('service_kind', p_service_kind));

  return v_lead_id;
end $$;

-- -----------------------------------------------------------------------------
-- RPC: log_message — идемпотентная запись сообщения
-- -----------------------------------------------------------------------------
create or replace function public.log_message(
  p_channel      messenger_channel,
  p_direction    message_direction,
  p_external_id  text,
  p_contact_id   uuid default null,
  p_lead_id      uuid default null,
  p_kind         message_kind default 'text',
  p_text         text default null,
  p_payload      jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into public.messages (channel, direction, kind, external_id, contact_id, lead_id, text, payload)
  values (p_channel, p_direction, p_kind, p_external_id, p_contact_id, p_lead_id, p_text, p_payload)
  on conflict (channel, direction, external_id) where external_id is not null do nothing
  returning id into v_id;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- RPC: set_lead_status
-- -----------------------------------------------------------------------------
create or replace function public.set_lead_status(
  p_lead_id   uuid,
  p_status    lead_status,
  p_actor     text default 'system'
) returns void
language plpgsql security definer as $$
declare
  v_old lead_status;
begin
  select status into v_old from public.leads where id = p_lead_id for update;
  if v_old is null then
    raise exception 'lead % not found', p_lead_id;
  end if;
  if v_old = p_status then
    return;
  end if;

  update public.leads set status = p_status, updated_at = now() where id = p_lead_id;

  insert into public.events (type, lead_id, payload)
  values ('lead.status_changed', p_lead_id,
          jsonb_build_object('from', v_old, 'to', p_status, 'actor', p_actor));
end $$;

-- -----------------------------------------------------------------------------
-- RPC: unsubscribe_contact
-- -----------------------------------------------------------------------------
create or replace function public.unsubscribe_contact(p_contact_id uuid, p_reason text default null)
returns void language plpgsql security definer as $$
begin
  update public.contacts
     set unsubscribed = true, unsubscribed_at = now()
   where id = p_contact_id and unsubscribed = false;

  insert into public.events (type, contact_id, payload)
  values ('contact.unsubscribed', p_contact_id, jsonb_build_object('reason', p_reason));
end $$;

-- -----------------------------------------------------------------------------
-- RPC: segment_for_recurring_lawn_mowing
--   Возвращает контакты, у которых:
--     - был покос N+ дней назад,
--     - не отписаны,
--     - сейчас сезон,
--     - не получали рассылку этой кампании.
--   Используется n8n cron-воркфлоу.
-- -----------------------------------------------------------------------------
create or replace function public.segment_for_recurring_lawn_mowing(
  p_days_since      int default 12,
  p_campaign_code   text default 'recurring_mowing',
  p_channel         messenger_channel default null
) returns table (
  contact_id      uuid,
  full_name       text,
  channel         messenger_channel,
  external_id     text,
  last_mowing_at  timestamptz,
  district        text
)
language sql stable as $$
  with last_mowing as (
    select l.contact_id, max(l.completed_at) as completed_at, max(l.district) as district
      from public.leads l
     where l.service_kind = 'lawn_mowing'
       and l.completed_at is not null
       and l.deleted_at is null
     group by l.contact_id
  ),
  campaign_sent as (
    select cr.contact_id, cr.channel
      from public.campaign_recipients cr
      join public.campaigns c on c.id = cr.campaign_id
     where c.code = p_campaign_code
       and cr.status in ('sent','pending')
       and cr.created_at > now() - interval '20 days'
  )
  select c.id, c.full_name, ci.channel, ci.external_id, lm.completed_at, lm.district
    from public.contacts c
    join last_mowing lm     on lm.contact_id = c.id
    join public.contact_identities ci on ci.contact_id = c.id and ci.is_blocked = false
   where c.deleted_at is null
     and c.unsubscribed = false
     and c.consent_marketing = true
     and lm.completed_at < now() - make_interval(days => p_days_since)
     and (p_channel is null or ci.channel = p_channel)
     and not exists (
       select 1 from campaign_sent cs
        where cs.contact_id = c.id and cs.channel = ci.channel
     )
     -- сезон покоса в северном полушарии: май..сентябрь
     and extract(month from now()) between 5 and 9;
$$;

-- -----------------------------------------------------------------------------
-- RPC: segment_for_seasonal_service
--   Универсальный сегмент: всем контактам с услугой service_kind в истории,
--   не отписанным, в активный сезон.
-- -----------------------------------------------------------------------------
create or replace function public.segment_for_seasonal_service(
  p_service_kind   service_kind,
  p_campaign_code  text,
  p_channel        messenger_channel default null
) returns table (
  contact_id   uuid,
  full_name    text,
  channel      messenger_channel,
  external_id  text,
  last_done_at timestamptz
)
language sql stable as $$
  with done as (
    select l.contact_id, max(l.completed_at) as completed_at
      from public.leads l
     where l.service_kind = p_service_kind
       and l.deleted_at is null
     group by l.contact_id
  ),
  campaign_sent as (
    select cr.contact_id, cr.channel
      from public.campaign_recipients cr
      join public.campaigns c on c.id = cr.campaign_id
     where c.code = p_campaign_code
       and cr.created_at > now() - interval '60 days'
  ),
  service_season as (
    select s.season_months from public.services s where s.kind = p_service_kind
  )
  select c.id, c.full_name, ci.channel, ci.external_id, d.completed_at
    from public.contacts c
    join done d on d.contact_id = c.id
    join public.contact_identities ci on ci.contact_id = c.id and ci.is_blocked = false
   where c.deleted_at is null
     and c.unsubscribed = false
     and c.consent_marketing = true
     and (p_channel is null or ci.channel = p_channel)
     and exists (
       select 1 from service_season ss
        where extract(month from now())::int = any(ss.season_months)
     )
     and not exists (
       select 1 from campaign_sent cs
        where cs.contact_id = c.id and cs.channel = ci.channel
     );
$$;

-- -----------------------------------------------------------------------------
-- VIEW: v_active_leads — удобно для админки и n8n (без soft-deleted)
-- -----------------------------------------------------------------------------
create or replace view public.v_active_leads as
select
  l.id,
  l.contact_id,
  c.full_name,
  c.phone,
  l.service_kind,
  s.name as service_name,
  l.channel,
  l.status,
  l.area_value,
  l.area_unit,
  l.district,
  l.price_quoted,
  l.price_final,
  l.last_activity_at,
  l.created_at
from public.leads l
join public.contacts c on c.id = l.contact_id
join public.services s on s.id = l.service_id
where l.deleted_at is null and c.deleted_at is null;
