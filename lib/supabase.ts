import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let _admin: SupabaseClient | null = null;

// Серверный клиент с service_role: обходит RLS, использовать ТОЛЬКО на сервере.
export function supabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  _admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application': 'premium-leadgen' } },
  });
  return _admin;
}

export type ServiceKind =
  | 'lawn_mowing'
  | 'scarification'
  | 'aeration'
  | 'land_clearing'
  | 'tree_cutting'
  | 'stump_removal'
  | 'debris_removal'
  | 'pool_cleaning'
  | 'pool_assembly';

export type Channel = 'telegram' | 'max' | 'whatsapp' | 'offline' | 'phone' | 'avito';

export async function upsertContactByIdentity(params: {
  channel: Channel;
  externalId: string;
  username?: string;
  displayName?: string;
  fullName?: string;
  phone?: string;
  sourceCode?: string;
}) {
  const { data, error } = await supabaseAdmin().rpc('upsert_contact_by_identity', {
    p_channel: params.channel,
    p_external_id: params.externalId,
    p_username: params.username ?? null,
    p_display_name: params.displayName ?? null,
    p_full_name: params.fullName ?? null,
    p_phone: params.phone ?? null,
    p_source_code: params.sourceCode ?? null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as { contact_id: string; identity_id: string; is_new: boolean };
}

export async function createLead(params: {
  contactId: string;
  serviceKind: ServiceKind;
  channel: Channel;
  description?: string;
  areaValue?: number;
  areaUnit?: string;
  district?: string;
  address?: string;
  metadata?: Record<string, unknown>;
}) {
  const { data, error } = await supabaseAdmin().rpc('create_lead', {
    p_contact_id: params.contactId,
    p_service_kind: params.serviceKind,
    p_channel: params.channel,
    p_description: params.description ?? null,
    p_area_value: params.areaValue ?? null,
    p_area_unit: params.areaUnit ?? null,
    p_district: params.district ?? null,
    p_address: params.address ?? null,
    p_metadata: params.metadata ?? {},
  });
  if (error) throw error;
  return data as string; // lead_id
}

export async function logMessage(params: {
  channel: Channel;
  direction: 'inbound' | 'outbound';
  externalId: string | null;
  contactId?: string;
  leadId?: string;
  kind?: 'text' | 'photo' | 'video' | 'document' | 'voice' | 'location' | 'contact' | 'system';
  text?: string;
  payload?: Record<string, unknown>;
}) {
  const { data, error } = await supabaseAdmin().rpc('log_message', {
    p_channel: params.channel,
    p_direction: params.direction,
    p_external_id: params.externalId,
    p_contact_id: params.contactId ?? null,
    p_lead_id: params.leadId ?? null,
    p_kind: params.kind ?? 'text',
    p_text: params.text ?? null,
    p_payload: params.payload ?? {},
  });
  if (error) throw error;
  return data as string | null;
}

export async function getOrCreateSession(identityId: string, channel: Channel) {
  const sb = supabaseAdmin();
  const { data: existing } = await sb
    .from('bot_sessions')
    .select('*')
    .eq('identity_id', identityId)
    .maybeSingle();
  if (existing) return existing;

  const { data, error } = await sb
    .from('bot_sessions')
    .insert({ identity_id: identityId, channel, funnel: 'main', step: 'start', state: {} })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateSession(identityId: string, patch: {
  funnel?: string;
  step?: string;
  state?: Record<string, unknown>;
}) {
  const { error } = await supabaseAdmin()
    .from('bot_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('identity_id', identityId);
  if (error) throw error;
}

export async function isInboxDuplicate(channel: Channel, externalId: string, payload: unknown) {
  // Идемпотентность: пытаемся вставить уникальную пару (channel, external_id).
  // Если уже существует — апдейт всё равно не упадёт благодаря on conflict do nothing.
  const sb = supabaseAdmin();
  const { error } = await sb
    .from('webhook_inbox')
    .insert({ channel, external_id: externalId, payload })
    // @ts-expect-error: onConflict у insert типизирован, но для clarity:
    .select();
  if (!error) return false; // вставили — это новый
  // 23505 = unique_violation в Postgres
  const code = (error as { code?: string }).code;
  return code === '23505';
}

export async function markInboxProcessed(channel: Channel, externalId: string, error?: string) {
  await supabaseAdmin()
    .from('webhook_inbox')
    .update({ processed_at: new Date().toISOString(), error: error ?? null })
    .eq('channel', channel)
    .eq('external_id', externalId);
}

export async function logToDb(level: 'debug'|'info'|'warn'|'error', source: string, message: string, context: Record<string, unknown> = {}) {
  try {
    await supabaseAdmin().from('app_logs').insert({ level, source, message, context });
  } catch {
    // не валим основной флоу из-за лога
  }
}
