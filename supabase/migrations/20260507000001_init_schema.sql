-- =============================================================================
-- Premium leadgen — initial schema
-- Migration: 20260507000001_init_schema.sql
-- =============================================================================

-- Расширения, которые понадобятся.
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- регистронезависимые строки
create extension if not exists "pg_trgm";    -- LIKE / fuzzy поиск

-- -----------------------------------------------------------------------------
-- ENUM-типы
-- -----------------------------------------------------------------------------
create type messenger_channel as enum ('telegram', 'max', 'whatsapp', 'offline', 'phone', 'avito');

create type service_kind as enum (
  'lawn_mowing',          -- покос газона
  'scarification',        -- скарификация
  'aeration',             -- аэрация
  'land_clearing',        -- расчистка участка
  'tree_cutting',         -- спил деревьев / веток
  'stump_removal',        -- корчевание пней
  'debris_removal',       -- вывоз мусора
  'pool_cleaning',        -- чистка бассейна
  'pool_assembly'         -- сборка/запуск бассейна
);

create type lead_status as enum (
  'new',                  -- только что создан, не обработан
  'qualifying',           -- идёт диалог
  'qualified',            -- собраны данные, можно считать смету
  'quoted',               -- цена названа
  'scheduled',            -- работа запланирована
  'in_progress',          -- работа выполняется
  'done',                 -- работа выполнена
  'lost',                 -- отказ / не дозвонились
  'archived'
);

create type message_direction as enum ('inbound', 'outbound');
create type message_kind as enum ('text', 'photo', 'video', 'document', 'voice', 'location', 'contact', 'system');

-- -----------------------------------------------------------------------------
-- Таблица: traffic_sources — каналы привлечения трафика
-- -----------------------------------------------------------------------------
create table public.traffic_sources (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,           -- 'avito', 'tg_channel_main', 'max_bot'
  name          text not null,
  channel       messenger_channel,
  description   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table  public.traffic_sources is 'Каналы привлечения трафика (Avito, Telegram-канал, MAX-бот и т.п.)';
comment on column public.traffic_sources.code is 'Машиночитаемый код, по нему идёт привязка из ботов';

-- -----------------------------------------------------------------------------
-- Таблица: services — справочник услуг
-- -----------------------------------------------------------------------------
create table public.services (
  id              uuid primary key default gen_random_uuid(),
  kind            service_kind not null unique,
  name            text not null,                -- "Покос газона"
  short_name      text not null,                -- для кнопок: "Покос"
  description     text,
  unit            text,                          -- 'сотка', 'м2', 'час', 'шт'
  price_min       numeric(12,2),
  price_max       numeric(12,2),
  season_months   int[] default '{}',            -- {5,6,7,8,9} = май-сентябрь
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table  public.services is 'Справочник предоставляемых услуг';
comment on column public.services.season_months is 'Месяцы сезона (1..12), для триггерных рассылок';

-- -----------------------------------------------------------------------------
-- Таблица: contacts — клиенты
-- -----------------------------------------------------------------------------
create table public.contacts (
  id                    uuid primary key default gen_random_uuid(),
  full_name             text,
  phone                 text,                    -- E.164: +7XXXXXXXXXX
  phone_normalized      text generated always as (regexp_replace(coalesce(phone,''),'[^0-9+]','','g')) stored,
  email                 citext,
  city                  text default 'Омск',
  district              text,                    -- район/посёлок
  address               text,
  geo_lat               numeric(10,7),
  geo_lon               numeric(10,7),
  preferred_channel     messenger_channel,       -- куда писать в первую очередь
  language              text not null default 'ru',
  consent_marketing     boolean not null default false, -- согласие на рассылки
  consent_marketing_at  timestamptz,
  unsubscribed          boolean not null default false,
  unsubscribed_at       timestamptz,
  notes                 text,
  source_id             uuid references public.traffic_sources(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz                -- soft delete
);
comment on table  public.contacts is 'Контакты (клиенты) — единая запись на человека во всех каналах';
comment on column public.contacts.unsubscribed is 'Флаг отписки. true = НЕ слать рассылки ни в один канал';

create index idx_contacts_phone        on public.contacts(phone_normalized);
create index idx_contacts_email        on public.contacts(email);
create index idx_contacts_city         on public.contacts(city);
create index idx_contacts_unsubscribed on public.contacts(unsubscribed) where unsubscribed = false;
create index idx_contacts_deleted      on public.contacts(deleted_at) where deleted_at is null;
create index idx_contacts_full_name_trgm on public.contacts using gin (full_name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Таблица: contact_identities — связи контакта с каналами (telegram_id, max_id и т.п.)
-- -----------------------------------------------------------------------------
create table public.contact_identities (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  channel       messenger_channel not null,
  external_id   text not null,                  -- chat_id / user_id в мессенджере
  username      text,                            -- @username (Telegram), nick (MAX)
  display_name  text,
  is_blocked    boolean not null default false, -- бот заблокирован пользователем
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (channel, external_id)
);
comment on table public.contact_identities is 'Идентификаторы контакта в каждом канале (один контакт — несколько identities)';

create index idx_contact_identities_contact on public.contact_identities(contact_id);
create index idx_contact_identities_channel on public.contact_identities(channel);

-- -----------------------------------------------------------------------------
-- Таблица: tags
-- -----------------------------------------------------------------------------
create table public.tags (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,            -- 'vip', 'big_lawn', 'pool_owner'
  name          text not null,
  color         text,                             -- HEX для UI
  description   text,
  created_at    timestamptz not null default now()
);
comment on table public.tags is 'Справочник тегов. Используем ОТДЕЛЬНУЮ таблицу + связи (а не jsonb), чтобы можно было быстро строить сегменты SQL-выборками для рассылок и иметь референциальную целостность';

create table public.contact_tags (
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  tag_id      uuid not null references public.tags(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

create table public.lead_tags (
  lead_id  uuid not null,
  tag_id   uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (lead_id, tag_id)
);

create index idx_contact_tags_tag on public.contact_tags(tag_id);
create index idx_lead_tags_tag    on public.lead_tags(tag_id);

-- -----------------------------------------------------------------------------
-- Таблица: leads — заявки
-- -----------------------------------------------------------------------------
create table public.leads (
  id                    uuid primary key default gen_random_uuid(),
  contact_id            uuid not null references public.contacts(id) on delete cascade,
  service_id            uuid not null references public.services(id),
  service_kind          service_kind not null,         -- денормализованно для фильтров
  source_id             uuid references public.traffic_sources(id) on delete set null,
  channel               messenger_channel not null,
  status                lead_status not null default 'new',

  -- параметры объекта
  area_value            numeric(12,2),                  -- площадь / объём
  area_unit             text,                            -- 'сотка', 'м2', 'час'
  description           text,                            -- что хочет клиент
  city                  text default 'Омск',
  district              text,
  address               text,

  -- бизнес-логика
  desired_date_from     date,
  desired_date_to       date,
  scheduled_at          timestamptz,
  completed_at          timestamptz,
  price_quoted          numeric(12,2),
  price_final           numeric(12,2),
  currency              text not null default 'RUB',

  -- метаданные
  metadata              jsonb not null default '{}'::jsonb,
  last_activity_at      timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
comment on table public.leads is 'Заявки от клиентов. Одна заявка = одна услуга. Повторный покос — новая запись со ссылкой на того же контакта';

alter table public.lead_tags
  add constraint lead_tags_lead_fk foreign key (lead_id) references public.leads(id) on delete cascade;

create index idx_leads_contact         on public.leads(contact_id);
create index idx_leads_service         on public.leads(service_id);
create index idx_leads_service_kind    on public.leads(service_kind);
create index idx_leads_status          on public.leads(status);
create index idx_leads_channel         on public.leads(channel);
create index idx_leads_last_activity   on public.leads(last_activity_at desc);
create index idx_leads_completed_at    on public.leads(completed_at desc) where completed_at is not null;
create index idx_leads_deleted         on public.leads(deleted_at) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- Таблица: lead_media — фото/видео объектов
-- -----------------------------------------------------------------------------
create table public.lead_media (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads(id) on delete cascade,
  kind         message_kind not null default 'photo',
  storage_path text,                             -- путь в Supabase Storage
  external_url text,                             -- file_id Telegram / URL MAX
  width        int,
  height       int,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);
create index idx_lead_media_lead on public.lead_media(lead_id);

-- -----------------------------------------------------------------------------
-- Таблица: messages — переписка с клиентом по всем каналам
-- -----------------------------------------------------------------------------
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid references public.contacts(id) on delete set null,
  lead_id         uuid references public.leads(id) on delete set null,
  channel         messenger_channel not null,
  direction       message_direction not null,
  kind            message_kind not null default 'text',
  external_id     text,                          -- message_id из Telegram/MAX
  text            text,
  payload         jsonb not null default '{}'::jsonb,  -- raw update / API response
  sent_at         timestamptz not null default now()
);
comment on table public.messages is 'Архив всех сообщений (входящие и исходящие). Используется и для аудита, и для идемпотентности';

create unique index uq_messages_external on public.messages(channel, direction, external_id) where external_id is not null;
create index idx_messages_contact  on public.messages(contact_id, sent_at desc);
create index idx_messages_lead     on public.messages(lead_id, sent_at desc);
create index idx_messages_channel  on public.messages(channel, sent_at desc);

-- -----------------------------------------------------------------------------
-- Таблица: bot_sessions — состояние диалога (state machine воронки)
-- -----------------------------------------------------------------------------
create table public.bot_sessions (
  id            uuid primary key default gen_random_uuid(),
  identity_id   uuid not null references public.contact_identities(id) on delete cascade,
  channel       messenger_channel not null,
  funnel        text not null,                  -- 'lawn_mowing' | 'pool_cleaning' | ...
  step          text not null default 'start',
  state         jsonb not null default '{}'::jsonb,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (identity_id)
);
comment on table public.bot_sessions is 'Текущий шаг воронки для пользователя. Один пользователь = одна активная сессия. Перезаписывается на каждом шаге';

create index idx_bot_sessions_funnel on public.bot_sessions(funnel, step);
create index idx_bot_sessions_expires on public.bot_sessions(expires_at);

-- -----------------------------------------------------------------------------
-- Таблица: campaigns — массовые рассылки
-- -----------------------------------------------------------------------------
create table public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  description   text,
  channel       messenger_channel,                -- если null — мульти-канальная
  service_kind  service_kind,
  segment_sql   text,                              -- SQL/RPC выборки сегмента
  message_text  text not null,                    -- шаблон сообщения
  buttons       jsonb not null default '[]'::jsonb,
  is_active     boolean not null default false,
  scheduled_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.campaigns is 'Кампании рассылок. n8n cron-воркфлоу читает is_active=true и scheduled_at <= now()';

-- -----------------------------------------------------------------------------
-- Таблица: campaign_recipients — кому ушло, кому нет
-- -----------------------------------------------------------------------------
create table public.campaign_recipients (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  contact_id   uuid not null references public.contacts(id) on delete cascade,
  channel      messenger_channel not null,
  status       text not null default 'pending',  -- pending | sent | failed | skipped
  error        text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (campaign_id, contact_id, channel)
);
create index idx_campaign_recipients_status on public.campaign_recipients(campaign_id, status);

-- -----------------------------------------------------------------------------
-- Таблица: events — бизнес-события (для аналитики и триггеров)
-- -----------------------------------------------------------------------------
create table public.events (
  id            bigserial primary key,
  type          text not null,                    -- 'lead.created', 'lead.status_changed', 'message.inbound', ...
  contact_id    uuid references public.contacts(id) on delete set null,
  lead_id       uuid references public.leads(id) on delete set null,
  channel       messenger_channel,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index idx_events_type    on public.events(type, created_at desc);
create index idx_events_contact on public.events(contact_id, created_at desc);
create index idx_events_lead    on public.events(lead_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Таблица: webhook_inbox — лог входящих апдейтов (для идемпотентности)
-- -----------------------------------------------------------------------------
create table public.webhook_inbox (
  id           bigserial primary key,
  channel      messenger_channel not null,
  external_id  text not null,                    -- update_id Telegram / MAX
  payload      jsonb not null,
  processed_at timestamptz,
  error        text,
  received_at  timestamptz not null default now(),
  unique (channel, external_id)
);
comment on table public.webhook_inbox is 'Все входящие вебхуки. Уникальный (channel, external_id) защищает от двойной обработки';

create index idx_webhook_inbox_unprocessed on public.webhook_inbox(channel, received_at) where processed_at is null;

-- -----------------------------------------------------------------------------
-- Таблица: app_logs — структурированные логи приложения
-- -----------------------------------------------------------------------------
create table public.app_logs (
  id          bigserial primary key,
  level       text not null,                     -- debug | info | warn | error
  source      text not null,                     -- 'vercel:tg-webhook' | 'n8n:wf-lead' | ...
  message     text not null,
  context     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index idx_app_logs_level on public.app_logs(level, created_at desc);
create index idx_app_logs_source on public.app_logs(source, created_at desc);

-- -----------------------------------------------------------------------------
-- updated_at триггер
-- -----------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare
  t text;
begin
  for t in select unnest(array[
    'traffic_sources','services','contacts','contact_identities',
    'leads','bot_sessions','campaigns'
  ]) loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function public.tg_set_updated_at()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- last_activity_at у leads — обновляем по входящим сообщениям
-- -----------------------------------------------------------------------------
create or replace function public.tg_bump_lead_activity()
returns trigger language plpgsql as $$
begin
  if new.lead_id is not null then
    update public.leads set last_activity_at = new.sent_at
     where id = new.lead_id and last_activity_at < new.sent_at;
  end if;
  return new;
end $$;

drop trigger if exists bump_lead_activity on public.messages;
create trigger bump_lead_activity after insert on public.messages
  for each row execute function public.tg_bump_lead_activity();
