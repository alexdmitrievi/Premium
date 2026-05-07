-- =============================================================================
-- Premium leadgen — Row Level Security
-- Migration: 20260507000003_rls.sql
--
-- Стратегия: вся логика в системе работает под service_role
-- (Vercel-функции, n8n) — она обходит RLS. Anon-клиент в браузере
-- НЕ должен видеть таблицы напрямую. Если позже появится админка с
-- Supabase Auth, добавим политики на роль 'authenticated'.
-- =============================================================================

alter table public.traffic_sources       enable row level security;
alter table public.services              enable row level security;
alter table public.contacts              enable row level security;
alter table public.contact_identities    enable row level security;
alter table public.tags                  enable row level security;
alter table public.contact_tags          enable row level security;
alter table public.lead_tags             enable row level security;
alter table public.leads                 enable row level security;
alter table public.lead_media            enable row level security;
alter table public.messages              enable row level security;
alter table public.bot_sessions          enable row level security;
alter table public.campaigns             enable row level security;
alter table public.campaign_recipients   enable row level security;
alter table public.events                enable row level security;
alter table public.webhook_inbox         enable row level security;
alter table public.app_logs              enable row level security;

-- Anon: только публичный справочник услуг (для будущей лендинг-витрины).
drop policy if exists "anon read services" on public.services;
create policy "anon read services" on public.services
  for select using (is_active = true);

-- Все остальные таблицы — БЕЗ политик для anon/authenticated.
-- service_role обходит RLS автоматически.
