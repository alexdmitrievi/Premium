-- =============================================================================
-- Premium leadgen — hardening RPC security
-- Migration: 20260507000005_harden_rpc_security.sql
--
-- ВАЖНО: миграции 1–4 оставляли SECURITY DEFINER RPC доступными для роли anon
-- через PostgREST. Это значило, что любой клиент с публичным anon-key мог
-- начислить себе бонус (grant_bonus), отписать чужой контакт и т.п.
-- Здесь это закрываем.
-- =============================================================================

-- 1. Revoke EXECUTE на всех бизнес-RPC от anon/authenticated/public.
--    Только service_role (Vercel-функции, n8n) может их вызывать.
do $$
declare
  fns text[] := array[
    'public.upsert_contact_by_identity(messenger_channel, text, text, text, text, text, text)',
    'public.create_lead(uuid, service_kind, messenger_channel, text, numeric, text, text, text, jsonb)',
    'public.log_message(messenger_channel, message_direction, text, uuid, uuid, message_kind, text, jsonb)',
    'public.set_lead_status(uuid, lead_status, text)',
    'public.unsubscribe_contact(uuid, text)',
    'public.segment_for_recurring_lawn_mowing(int, text, messenger_channel)',
    'public.segment_for_seasonal_service(service_kind, text, messenger_channel)',
    'public.ensure_referral_code(uuid)',
    'public.record_referral_visit(uuid, text)',
    'public.grant_bonus(uuid, int, text, uuid, uuid)',
    'public.spend_bonus(uuid, int, uuid)',
    'public.refund_bonus(uuid)',
    'public.compute_discount_for_contact(uuid, service_kind)',
    'public.qualify_referral(uuid, uuid, int)'
  ];
  fn text;
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public',        fn);
    execute format('revoke execute on function %s from anon',          fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant  execute on function %s to   service_role',  fn);
  end loop;
end $$;

-- 2. Закрепить search_path во всех функциях.
--    Без этого SECURITY DEFINER может стать вектором атаки через подмену
--    объектов в чужой схеме.
alter function public.tg_set_updated_at()           set search_path = public, pg_temp;
alter function public.tg_bump_lead_activity()       set search_path = public, pg_temp;
alter function public.tg_bump_total_orders()        set search_path = public, pg_temp;
alter function public.tg_qualify_referral_on_done() set search_path = public, pg_temp;

alter function public.upsert_contact_by_identity(messenger_channel, text, text, text, text, text, text)
  set search_path = public, pg_temp;
alter function public.create_lead(uuid, service_kind, messenger_channel, text, numeric, text, text, text, jsonb)
  set search_path = public, pg_temp;
alter function public.log_message(messenger_channel, message_direction, text, uuid, uuid, message_kind, text, jsonb)
  set search_path = public, pg_temp;
alter function public.set_lead_status(uuid, lead_status, text)
  set search_path = public, pg_temp;
alter function public.unsubscribe_contact(uuid, text)
  set search_path = public, pg_temp;
alter function public.segment_for_recurring_lawn_mowing(int, text, messenger_channel)
  set search_path = public, pg_temp;
alter function public.segment_for_seasonal_service(service_kind, text, messenger_channel)
  set search_path = public, pg_temp;

alter function public.ensure_referral_code(uuid)               set search_path = public, pg_temp;
alter function public.record_referral_visit(uuid, text)        set search_path = public, pg_temp;
alter function public.grant_bonus(uuid, int, text, uuid, uuid) set search_path = public, pg_temp;
alter function public.spend_bonus(uuid, int, uuid)             set search_path = public, pg_temp;
alter function public.refund_bonus(uuid)                       set search_path = public, pg_temp;
alter function public.compute_discount_for_contact(uuid, service_kind) set search_path = public, pg_temp;
alter function public.qualify_referral(uuid, uuid, int)        set search_path = public, pg_temp;

-- 3. Views с security_invoker=true — RLS таблиц-источников применяется.
alter view public.v_active_leads  set (security_invoker = true);
alter view public.v_my_orders     set (security_invoker = true);
alter view public.v_my_referrals  set (security_invoker = true);

-- 4. Перенос pg_trgm и citext в схему extensions (рекомендация Supabase).
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
alter extension citext  set schema extensions;
alter extension pg_trgm set schema extensions;
