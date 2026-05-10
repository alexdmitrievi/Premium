// Read/write-операции для разделов "Мои заказы", "Реферальная программа",
// "Повторить заказ", "Скидка/бонусы". Используется и в Telegram, и в MAX.

import { supabaseAdmin, type Channel, type ServiceKind } from './supabase';
import type { CustomerType } from './funnels';

export type OrderRow = {
  id: string;
  contact_id: string;
  human_id: string;
  service_kind: ServiceKind;
  service_name: string;
  service_short: string;
  status: string;
  area_value: number | null;
  area_unit: string | null;
  district: string | null;
  desired_date_from: string | null;
  desired_date_to: string | null;
  scheduled_at: string | null;
  price_quoted: number | null;
  price_final: number | null;
  discount_percent: number;
  discount_rub: number;
  repeat_of: string | null;
  created_at: string;
  last_activity_at: string;
};

export async function listMyOrders(contactId: string, limit = 5): Promise<OrderRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('v_my_orders')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OrderRow[];
}

export async function getOrder(contactId: string, leadId: string): Promise<OrderRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('v_my_orders')
    .select('*')
    .eq('contact_id', contactId)
    .eq('id', leadId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as OrderRow | null;
}

export async function cancelMyOrder(contactId: string, leadId: string): Promise<boolean> {
  const sb = supabaseAdmin();
  // двойная защита: только если контакт совпал и статус позволяет
  const { data: lead, error: e1 } = await sb
    .from('leads').select('id, status, contact_id').eq('id', leadId).maybeSingle();
  if (e1) throw e1;
  if (!lead || lead.contact_id !== contactId) return false;
  if (!['new','qualifying','qualified','quoted','scheduled'].includes(lead.status)) return false;

  const { error: e2 } = await sb.rpc('set_lead_status', {
    p_lead_id: leadId, p_status: 'lost', p_actor: 'user',
  });
  if (e2) throw e2;

  // вернём бонус, если был списан
  await sb.rpc('refund_bonus', { p_lead_id: leadId });
  return true;
}

export async function updateOrderDate(
  contactId: string, leadId: string,
  range: { from: string; to: string; human: string },
): Promise<boolean> {
  const sb = supabaseAdmin();
  const { data: lead, error } = await sb
    .from('leads').select('id, contact_id, status, metadata').eq('id', leadId).maybeSingle();
  if (error) throw error;
  if (!lead || lead.contact_id !== contactId) return false;
  if (!['new','qualifying','qualified','quoted','scheduled'].includes(lead.status)) return false;

  const meta = (lead.metadata ?? {}) as Record<string, unknown>;
  const { error: e2 } = await sb.from('leads').update({
    desired_date_from: range.from,
    desired_date_to: range.to,
    metadata: { ...meta, when_label_human: range.human },
    updated_at: new Date().toISOString(),
  }).eq('id', leadId);
  if (e2) throw e2;
  return true;
}

// ----------------------------- Customer type (B2C / B2B) -----------------
export async function getCustomerType(contactId: string): Promise<CustomerType | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts').select('customer_type').eq('id', contactId).maybeSingle();
  if (error) throw error;
  const v = (data as { customer_type: CustomerType | null } | null)?.customer_type ?? null;
  return v;
}

export async function setCustomerType(contactId: string, type: CustomerType): Promise<void> {
  const { error } = await supabaseAdmin()
    .rpc('set_customer_type', { p_contact_id: contactId, p_customer_type: type });
  if (error) throw error;
}

// ----------------------------- Referral ----------------------------------
export async function ensureReferralCode(contactId: string): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .rpc('ensure_referral_code', { p_contact_id: contactId });
  if (error) throw error;
  return data as string;
}

export async function recordReferralVisit(inviteeContactId: string, code: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .rpc('record_referral_visit', { p_invitee_contact_id: inviteeContactId, p_code: code });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function getReferralStats(contactId: string): Promise<{
  invited: number; qualified: number; balance: number;
}> {
  const sb = supabaseAdmin();
  const [{ data: invited }, { data: balance }] = await Promise.all([
    sb.from('v_my_referrals').select('id, status').eq('referrer_contact_id', contactId),
    sb.from('loyalty_balances').select('bonus_rub').eq('contact_id', contactId).maybeSingle(),
  ]);
  const list = (invited ?? []) as Array<{ status: string }>;
  return {
    invited: list.length,
    qualified: list.filter(r => r.status === 'qualified').length,
    balance: ((balance as { bonus_rub: number } | null)?.bonus_rub) ?? 0,
  };
}

export async function getReferralList(contactId: string) {
  const { data, error } = await supabaseAdmin()
    .from('v_my_referrals').select('*').eq('referrer_contact_id', contactId)
    .order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  return (data ?? []) as Array<{
    id: string; invitee_name: string | null; status: string;
    created_at: string; qualified_at: string | null;
  }>;
}

// ----------------------------- Discounts ---------------------------------
export async function computeDiscount(contactId: string, kind: ServiceKind): Promise<{
  percent: number; bonusRub: number;
}> {
  const { data, error } = await supabaseAdmin().rpc('compute_discount_for_contact', {
    p_contact_id: contactId, p_service_kind: kind,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    percent:  (row?.percent  ?? 0) as number,
    bonusRub: (row?.rub_bonus ?? 0) as number,
  };
}

// Зафиксировать скидку и списать бонус (cap = 500 ₽ за заказ).
const PER_ORDER_BONUS_CAP = 500;

export async function applyDiscountToLead(
  contactId: string, leadId: string, percent: number, bonusRub: number,
): Promise<{ usedBonus: number }> {
  const sb = supabaseAdmin();
  let usedBonus = 0;
  if (bonusRub > 0) {
    const { data, error } = await sb.rpc('spend_bonus', {
      p_contact_id: contactId,
      p_amount: Math.min(bonusRub, PER_ORDER_BONUS_CAP),
      p_lead_id: leadId,
    });
    if (error) throw error;
    usedBonus = (data as number) ?? 0;
  }
  const { error: e2 } = await sb.from('leads').update({
    discount_percent: percent,
    discount_rub: usedBonus,
    updated_at: new Date().toISOString(),
  }).eq('id', leadId);
  if (e2) throw e2;
  return { usedBonus };
}

// ----------------------------- Repeat ------------------------------------
export async function repeatOrder(args: {
  contactId: string;
  oldLeadId: string;
  channel: Channel;
  desiredDate: { from: string; to: string; human: string; label: string };
}): Promise<{ newLeadId: string; oldOrder: OrderRow }> {
  const old = await getOrder(args.contactId, args.oldLeadId);
  if (!old) throw new Error('lead not found');

  const sb = supabaseAdmin();
  const { data: leadId, error } = await sb.rpc('create_lead', {
    p_contact_id: args.contactId,
    p_service_kind: old.service_kind,
    p_channel: args.channel,
    p_description: null,
    p_area_value: old.area_value,
    p_area_unit: old.area_unit,
    p_district: old.district,
    p_address: null,
    p_metadata: {
      repeat_of: args.oldLeadId,
      when_label: args.desiredDate.label,
      when_label_human: args.desiredDate.human,
    },
  });
  if (error) throw error;

  const newLeadId = leadId as string;
  await sb.from('leads').update({
    repeat_of: args.oldLeadId,
    desired_date_from: args.desiredDate.from,
    desired_date_to: args.desiredDate.to,
  }).eq('id', newLeadId);

  return { newLeadId, oldOrder: old };
}
