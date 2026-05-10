import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  MaxUpdate, MaxUser, sendMaxMessage,
  maxMainMenuB2cButtons, maxMainMenuB2bButtons, maxCustomerTypeButtons,
  maxAreaBucketsButtons, maxDistrictButtons, maxWhenButtons,
  maxConfirmButtons, maxPostOrderButtons, maxOrderCardButtons, maxReferralButtons,
  type MaxButton,
} from '../../lib/max';
import { env } from '../../lib/env';
import { verifyHmac } from '../../lib/verify';
import {
  upsertContactByIdentity, createLead, logMessage,
  getOrCreateSession, updateSession, isInboxDuplicate,
  markInboxProcessed, logToDb, supabaseAdmin,
  type ServiceKind, type Channel,
} from '../../lib/supabase';
import { notifyN8n } from '../../lib/n8n';
import {
  UI, SERVICE_LABEL, districtName,
  parseArea, parseAreaBucket, whenLabelToRange,
  estimatePriceRange, applyDiscountToRange, formatRub, formatDateRange,
  mapStatusToUi, canCancelStatus, canEditDateStatus,
  type SessionState,
} from '../../lib/funnels';
import {
  listMyOrders, getOrder, cancelMyOrder, updateOrderDate,
  ensureReferralCode, recordReferralVisit, getReferralStats, getReferralList,
  computeDiscount, applyDiscountToLead, repeatOrder,
  getCustomerType, setCustomerType,
} from '../../lib/orders';
import type { CustomerType } from '../../lib/funnels';

const CHANNEL: Channel = 'max';

type Ctx = {
  userId: number;
  chatId?: number;
  fromUser: MaxUser;
  contactId: string;
  identityId: string;
  customerType: CustomerType | null;
  session: { funnel: string; step: string; state: SessionState };
};

// Универсальный шорткат отправки сообщения с кнопками или без.
async function send(ctx: Ctx, text: string, buttons?: MaxButton[][]) {
  await sendMaxMessage({ userId: ctx.userId, chatId: ctx.chatId, text, buttons });
}

function menuButtonsFor(ctx: Ctx): MaxButton[][] {
  return ctx.customerType === 'b2b' ? maxMainMenuB2bButtons() : maxMainMenuB2cButtons();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const sig = req.headers['x-max-signature'] as string | undefined;
  const raw = JSON.stringify(req.body ?? {});
  if (env.MAX_WEBHOOK_SECRET && !verifyHmac(env.MAX_WEBHOOK_SECRET, raw, sig)) {
    await logToDb('warn', 'vercel:max-webhook', 'Bad signature', {});
    res.status(401).send('Unauthorized'); return;
  }

  const update = req.body as MaxUpdate;
  if (!update || !update.update_type) { res.status(400).send('Bad payload'); return; }

  const externalId =
    update.message?.body?.mid ??
    update.callback?.callback_id ??
    `${update.update_type}:${update.timestamp}`;

  const dup = await isInboxDuplicate(CHANNEL, externalId, update);
  if (dup) { res.status(200).json({ ok: true, duplicate: true }); return; }

  notifyN8n(env.N8N_MAX_WEBHOOK_URL || env.N8N_WEBHOOK_URL, { type: 'max.update', update });

  try {
    if (update.update_type === 'message_created' && update.message) await onMessage(update.message);
    if (update.update_type === 'message_callback' && update.callback) await onCallback(update.callback);

    await markInboxProcessed(CHANNEL, externalId);
    res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logToDb('error', 'vercel:max-webhook', msg, { externalId });
    await markInboxProcessed(CHANNEL, externalId, msg);
    res.status(200).json({ ok: false, error: msg });
  }
}

async function loadCtx(from: MaxUser, chatId?: number): Promise<Ctx> {
  const { contact_id, identity_id } = await upsertContactByIdentity({
    channel: CHANNEL,
    externalId: String(from.user_id),
    username: from.username,
    displayName: from.name,
    fullName: from.name,
    sourceCode: 'max_bot',
  });
  const [session, customerType] = await Promise.all([
    getOrCreateSession(identity_id, CHANNEL),
    getCustomerType(contact_id),
  ]);
  return {
    userId: from.user_id, chatId,
    fromUser: from, contactId: contact_id, identityId: identity_id,
    customerType,
    session: {
      funnel: session.funnel, step: session.step,
      state: (session.state ?? {}) as SessionState,
    },
  };
}

// ---------------------------------------------------------------------------
async function onMessage(m: NonNullable<MaxUpdate['message']>) {
  const ctx = await loadCtx(m.sender, m.recipient.chat_id);
  const text = (m.body.text ?? '').trim();

  await logMessage({
    channel: CHANNEL, direction: 'inbound', externalId: m.body.mid,
    contactId: ctx.contactId, kind: 'text', text, payload: m as unknown as Record<string, unknown>,
  });

  // /start ref_<code>
  const refMatch = text.match(/^\/start\s+ref_([A-Z0-9]{4,12})$/i);
  if (refMatch) {
    const code = refMatch[1]!.toUpperCase();
    const refId = await recordReferralVisit(ctx.contactId, code);
    if (refId) {
      await send(ctx, UI.referralActivated(), menuButtonsFor(ctx));
    } else {
      await showHome(ctx);
    }
    await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
    return;
  }

  if (text === '/start' || /^(меню|menu)$/i.test(text)) {
    await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
    await showHome(ctx);
    return;
  }

  if (/^(стоп|отписаться|stop)$/i.test(text)) {
    await supabaseAdmin().rpc('unsubscribe_contact', { p_contact_id: ctx.contactId, p_reason: 'user_request' });
    await send(ctx, 'Вы отписаны от рассылок. Заказы по-прежнему доступны через меню.');
    return;
  }

  await advanceText(ctx, text);
}

async function onCallback(cb: NonNullable<MaxUpdate['callback']>) {
  const ctx = await loadCtx(cb.user);
  const data = cb.payload;
  const [scope, action, ...rest] = data.split(':');
  const arg = rest.join(':');

  switch (scope) {
    case 'ctype':     return pickCustomerType(ctx, action === 'b2b' ? 'b2b' : 'b2c');
    case 'svc':       return startOrder(ctx, action as ServiceKind);
    case 'area':      return setArea(ctx, action as 'lawn'|'land'|'pool', arg);
    case 'dist':      return setDistrict(ctx, action!);
    case 'when':      return setWhen(ctx, action!);
    case 'confirm':   return action === 'ok' ? confirmOrder(ctx) : cancelDuringOrder(ctx);
    case 'edit':      return editField(ctx, action!);
    case 'lead':      return leadAction(ctx, action!, arg);
    case 'back':      return showHome(ctx);
    case 'nav': {
      switch (action) {
        case 'home':           return showHome(ctx);
        case 'orders':         return showMyOrders(ctx);
        case 'referral':       return showReferral(ctx);
        case 'referral_list':  return showReferralList(ctx);
        case 'help':           return send(ctx, UI.help, menuButtonsFor(ctx));
        case 'operator':       return showOperator(ctx);
        case 'reset_ctype':    return resetCustomerType(ctx);
      }
    }
  }
}

async function pickCustomerType(ctx: Ctx, type: CustomerType) {
  await setCustomerType(ctx.contactId, type);
  ctx.customerType = type;
  const ack = type === 'b2b'
    ? 'Принято — оформляем для компании / стройки. Менеджер подтвердит цены и условия.'
    : 'Принято — подбираю меню для частного дома.';
  await send(ctx, ack);
  await showHome(ctx);
}

async function resetCustomerType(ctx: Ctx) {
  ctx.customerType = null;
  await updateSession(ctx.identityId, { funnel: 'main', step: 'pick_customer_type', state: { screen: 'pick_customer_type' } });
  await send(ctx, 'Сбросил тип клиента. Выберите заново:', maxCustomerTypeButtons());
}

// ---------------------------------------------------------------------------
async function showHome(ctx: Ctx) {
  if (!ctx.customerType) {
    await updateSession(ctx.identityId, {
      funnel: 'main', step: 'pick_customer_type', state: { screen: 'pick_customer_type' },
    });
    await send(ctx, UI.audiencePicker(ctx.fromUser.name, env.BOT_BRAND_NAME, /* strict */ true), maxCustomerTypeButtons());
    return;
  }
  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home', customerType: ctx.customerType } });
  await send(ctx, UI.homeWelcome(ctx.fromUser.name, env.BOT_BRAND_NAME, /* strict */ true), menuButtonsFor(ctx));
}

async function showOperator(ctx: Ctx, leadId?: string) {
  await updateSession(ctx.identityId, { funnel: 'operator', step: 'phone', state: { screen: 'operator', activeLeadId: leadId } });
  await send(ctx, UI.operator);
}

async function showMyOrders(ctx: Ctx) {
  const orders = await listMyOrders(ctx.contactId, 5);
  if (orders.length === 0) {
    await send(ctx, UI.myOrdersEmpty, menuButtonsFor(ctx)); return;
  }
  await send(ctx, UI.myOrdersHeader);
  for (const o of orders) {
    const ui = mapStatusToUi(o.status);
    const card = UI.orderCard({
      humanId: o.human_id, serviceName: o.service_name,
      statusIcon: ui.icon, statusLabel: ui.label,
      when: formatDateRange(o.desired_date_from, o.desired_date_to),
      district: o.district ?? undefined,
      area: o.area_value ? `${o.area_value} ${o.area_unit ?? ''}`.trim() : undefined,
      priceQuoted: o.price_quoted ?? undefined,
      discountPercent: o.discount_percent || undefined,
    });
    await send(ctx, card, maxOrderCardButtons({
      leadId: o.id,
      canEditDate: canEditDateStatus(o.status),
      canCancel: canCancelStatus(o.status),
      isCompleted: o.status === 'done' || o.status === 'lost' || o.status === 'archived',
    }));
  }
  await send(ctx, '—', [[{ type: 'callback', text: 'В меню', payload: 'nav:home' }]]);
}

async function showReferral(ctx: Ctx) {
  const code = await ensureReferralCode(ctx.contactId);
  const stats = await getReferralStats(ctx.contactId);
  const link = `https://max.ru/${env.MAX_BOT_USERNAME}?start=ref_${code}`;
  await send(ctx, UI.referralIntro({
    link, invited: stats.invited, balance: stats.balance,
  }), maxReferralButtons(link));
}

async function showReferralList(ctx: Ctx) {
  const rows = await getReferralList(ctx.contactId);
  if (rows.length === 0) { await send(ctx, UI.referralListEmpty); return; }
  const lines = [UI.referralListHeader, ''];
  for (const r of rows) {
    lines.push(UI.referralListItem({
      name: r.invitee_name ?? 'Друг',
      status: r.status,
      date: r.qualified_at ? new Date(r.qualified_at).toLocaleDateString('ru-RU') : '',
    }));
  }
  await send(ctx, lines.join('\n'), [[{ type: 'callback', text: 'В меню', payload: 'nav:home' }]]);
}

// ---------------------------------------------------------------------------
async function startOrder(ctx: Ctx, kind: ServiceKind) {
  const state: SessionState = { screen: 'order', serviceKind: kind };
  await updateSession(ctx.identityId, { funnel: 'order', step: 'params', state });
  await send(ctx, UI.orderServiceIntro(kind));
  await send(ctx, UI.askArea(kind), maxAreaBucketsButtons(scopeForKind(kind)));
}

function scopeForKind(k: ServiceKind): 'lawn' | 'land' | 'pool' {
  if (k === 'pool_cleaning' || k === 'pool_assembly') return 'pool';
  if (k === 'land_clearing' || k === 'tree_cutting' || k === 'stump_removal' || k === 'debris_removal') return 'land';
  return 'lawn';
}

async function setArea(ctx: Ctx, _scope: 'lawn'|'land'|'pool', arg: string) {
  if (arg === 'custom') {
    await updateSession(ctx.identityId, { step: 'params', state: { ...ctx.session.state, areaBucket: 'custom' } });
    await send(ctx, 'Напишите площадь или объём цифрой — например, «8 соток» или «400 м²».');
    return;
  }
  const parsed = parseAreaBucket(`area:_:${arg}`);
  if (!parsed) { await send(ctx, 'Не распознал площадь.'); return; }
  const state: SessionState = { ...ctx.session.state, area: parsed.max, areaUnit: parsed.unit, areaBucket: parsed.bucket };
  await updateSession(ctx.identityId, { step: 'district', state });
  await send(ctx, UI.askDistrictTitle, maxDistrictButtons());
}

async function setDistrict(ctx: Ctx, code: string) {
  if (code === 'other') {
    await updateSession(ctx.identityId, { step: 'district', state: { ...ctx.session.state, districtCode: 'other' } });
    await send(ctx, 'Напишите название района или посёлка одной строкой.');
    return;
  }
  const name = districtName(code) ?? code;
  await updateSession(ctx.identityId, { step: 'when', state: { ...ctx.session.state, districtCode: code, district: name } });
  await send(ctx, UI.askWhenTitle, maxWhenButtons());
}

async function setWhen(ctx: Ctx, label: string) {
  if (label === 'custom') {
    await updateSession(ctx.identityId, { step: 'when', state: { ...ctx.session.state, whenLabel: 'custom' } });
    await send(ctx, 'Напишите удобную дату — например, «10 мая».');
    return;
  }
  const range = whenLabelToRange(label);
  if (!range) { await send(ctx, 'Не понял дату.', maxWhenButtons()); return; }
  const state: SessionState = {
    ...ctx.session.state, whenLabel: label, whenHuman: range.human, whenFrom: range.from, whenTo: range.to,
  };

  if (ctx.session.funnel === 'repeat' && state.activeLeadId) { await finishRepeatOrder(ctx, state); return; }
  if (ctx.session.funnel === 'edit_date' && state.activeLeadId) { await finishEditDate(ctx, state, range); return; }

  await updateSession(ctx.identityId, { step: 'confirm', state });
  await renderConfirm(ctx, state);
}

async function renderConfirm(ctx: Ctx, state: SessionState) {
  const kind = state.serviceKind!;
  const units = state.area ?? 1;
  const range = estimatePriceRange(kind, units);
  const { percent, bonusRub } = await computeDiscount(ctx.contactId, kind);
  const finalRange = applyDiscountToRange(range, percent, Math.min(bonusRub, 500));

  await updateSession(ctx.identityId, { step: 'confirm', state: { ...state, discountPercent: percent, bonusRub: Math.min(bonusRub, 500) } });
  await send(ctx, UI.orderConfirm({
    service: SERVICE_LABEL[kind],
    area: state.areaBucket && state.areaBucket !== 'custom' ? bucketLabel(state.areaBucket) : (state.area ? `${state.area} ${state.areaUnit ?? ''}`.trim() : undefined),
    district: state.district, when: state.whenHuman,
    priceLow: range.low, priceHigh: range.high,
    discountPercent: percent || undefined,
    bonusRub: Math.min(bonusRub, 500) || undefined,
    finalLow: percent || bonusRub ? finalRange.low : undefined,
    finalHigh: percent || bonusRub ? finalRange.high : undefined,
  }), maxConfirmButtons());
}

function bucketLabel(b: string): string {
  switch (b) {
    case '5': return 'до 5 соток';
    case '10': return '5–10 соток';
    case '20': return '10–20 соток';
    case '30': return '20+ соток';
    default: return b;
  }
}

async function editField(ctx: Ctx, field: string) {
  if (field === 'when')      { await updateSession(ctx.identityId, { step: 'when', state: ctx.session.state });     await send(ctx, UI.askWhenTitle, maxWhenButtons()); return; }
  if (field === 'district')  { await updateSession(ctx.identityId, { step: 'district', state: ctx.session.state }); await send(ctx, UI.askDistrictTitle, maxDistrictButtons()); return; }
}

async function cancelDuringOrder(ctx: Ctx) {
  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
  await send(ctx, 'Отменено. Возвращаю в меню.', menuButtonsFor(ctx));
}

async function confirmOrder(ctx: Ctx) {
  const state = ctx.session.state;
  if (!state.serviceKind) { await showHome(ctx); return; }

  const { data: contact } = await supabaseAdmin().from('contacts').select('phone').eq('id', ctx.contactId).maybeSingle();
  if (!contact?.phone) {
    await updateSession(ctx.identityId, { step: 'phone', state });
    await send(ctx, UI.askPhoneTitle);
    return;
  }
  await finishOrder(ctx, state, contact.phone);
}

async function finishOrder(ctx: Ctx, state: SessionState, phone: string) {
  const kind = state.serviceKind!;
  const leadId = await createLead({
    contactId: ctx.contactId, serviceKind: kind, channel: CHANNEL,
    description: state.description, areaValue: state.area, areaUnit: state.areaUnit, district: state.district,
    metadata: {
      desiredDate: state.whenHuman, whenLabel: state.whenLabel,
      whenFrom: state.whenFrom, whenTo: state.whenTo,
      mediaIds: state.mediaIds ?? [], phone,
    },
  });
  if (state.whenFrom) {
    await supabaseAdmin().from('leads').update({
      desired_date_from: state.whenFrom, desired_date_to: state.whenTo ?? state.whenFrom,
    }).eq('id', leadId);
  }
  const percent = state.discountPercent ?? 0;
  const bonus = state.bonusRub ?? 0;
  if (percent || bonus) await applyDiscountToLead(ctx.contactId, leadId, percent, bonus);

  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
  const order = await getOrder(ctx.contactId, leadId);
  await send(ctx, UI.thanksCard({
    humanId: order?.human_id ?? 'A-' + leadId.slice(0,4).toUpperCase(),
    service: SERVICE_LABEL[kind], when: state.whenHuman, district: state.district,
  }), maxPostOrderButtons());

  notifyN8n(env.N8N_WEBHOOK_URL, {
    type: 'lead.created', leadId, contactId: ctx.contactId, serviceKind: kind, channel: CHANNEL,
  });
}

async function finishRepeatOrder(ctx: Ctx, state: SessionState) {
  if (!state.activeLeadId) { await showHome(ctx); return; }
  const range = whenLabelToRange(state.whenLabel ?? 'today');
  if (!range) { await showHome(ctx); return; }

  const { newLeadId, oldOrder } = await repeatOrder({
    contactId: ctx.contactId, oldLeadId: state.activeLeadId, channel: CHANNEL,
    desiredDate: { ...range, label: state.whenLabel ?? 'today' },
  });
  const { percent, bonusRub } = await computeDiscount(ctx.contactId, oldOrder.service_kind);
  await applyDiscountToLead(ctx.contactId, newLeadId, percent, bonusRub);

  const order = await getOrder(ctx.contactId, newLeadId);
  const units = oldOrder.area_value ?? 1;
  const priceR = estimatePriceRange(oldOrder.service_kind, units);
  const finalR = applyDiscountToRange(priceR, percent, Math.min(bonusRub, 500));

  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
  await send(ctx, UI.thanksRepeat({
    humanId: order?.human_id ?? 'A-' + newLeadId.slice(0,4).toUpperCase(),
    service: SERVICE_LABEL[oldOrder.service_kind], when: range.human,
    discountPercent: percent || undefined,
    finalPrice: percent || bonusRub ? `${formatRub(finalR.low)}–${formatRub(finalR.high)}` : undefined,
  }), maxPostOrderButtons());

  notifyN8n(env.N8N_WEBHOOK_URL, {
    type: 'lead.created', leadId: newLeadId, contactId: ctx.contactId,
    serviceKind: oldOrder.service_kind, channel: CHANNEL,
  });
}

async function finishEditDate(ctx: Ctx, state: SessionState, range: { from: string; to: string; human: string }) {
  if (!state.activeLeadId) { await showHome(ctx); return; }
  const ok = await updateOrderDate(ctx.contactId, state.activeLeadId, range);
  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
  await send(ctx,
    ok ? `Дата обновлена: ${range.human}` : 'Не удалось изменить дату — возможно, заказ уже в работе.',
    [[{ type: 'callback', text: 'В меню', payload: 'nav:home' }]]);
}

async function leadAction(ctx: Ctx, action: string, leadId: string) {
  if (!leadId) return;
  if (action === 'contact') return showOperator(ctx, leadId);

  if (action === 'cancel') {
    const ok = await cancelMyOrder(ctx.contactId, leadId);
    await send(ctx,
      ok ? 'Заказ отменён. Возвратили бонусы, если использовались.' : 'Заказ уже в работе — отменить нельзя. Свяжитесь с оператором.',
      [[{ type: 'callback', text: 'В меню', payload: 'nav:home' }]]);
    return;
  }

  if (action === 'repeat') {
    const old = await getOrder(ctx.contactId, leadId);
    if (!old) { await send(ctx, 'Заказ не найден.'); return; }
    await updateSession(ctx.identityId, {
      funnel: 'repeat', step: 'when',
      state: {
        screen: 'repeat', activeLeadId: leadId,
        serviceKind: old.service_kind,
        district: old.district ?? undefined,
        area: old.area_value ?? undefined,
        areaUnit: old.area_unit ?? undefined,
      },
    });
    await send(ctx, UI.repeatHeader({
      service: SERVICE_LABEL[old.service_kind],
      district: old.district ?? undefined,
      area: old.area_value ? `${old.area_value} ${old.area_unit ?? ''}`.trim() : undefined,
    }), maxWhenButtons());
    return;
  }

  if (action === 'edit_date') {
    const old = await getOrder(ctx.contactId, leadId);
    if (!old) return;
    await updateSession(ctx.identityId, {
      funnel: 'edit_date', step: 'when',
      state: { screen: 'edit_date', activeLeadId: leadId, serviceKind: old.service_kind },
    });
    await send(ctx, 'Когда удобно?', maxWhenButtons());
    return;
  }
}

async function advanceText(ctx: Ctx, text: string) {
  const { funnel, step, state } = ctx.session;

  if (step === 'phone') {
    const phone = text.replace(/[^\d+]/g, '');
    if (phone.length < 7) { await send(ctx, 'Не похоже на телефон. Пришлите номер цифрами.'); return; }
    await supabaseAdmin().from('contacts').update({ phone }).eq('id', ctx.contactId).is('phone', null);
    if (funnel === 'operator') {
      await send(ctx, 'Номер принят. Оператор свяжется в течение 30 минут.', [[{ type: 'callback', text: 'В меню', payload: 'nav:home' }]]);
      await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
      return;
    }
    await finishOrder(ctx, state, phone);
    return;
  }

  if (step === 'params' && state.areaBucket === 'custom') {
    const a = parseArea(text);
    if (!a) { await send(ctx, 'Не понял площадь. Например, «8 соток» или «400 м²».'); return; }
    await updateSession(ctx.identityId, { step: 'district', state: { ...state, area: a.value, areaUnit: a.unit, areaBucket: undefined } });
    await send(ctx, UI.askDistrictTitle, maxDistrictButtons());
    return;
  }

  if (step === 'district' && state.districtCode === 'other') {
    await updateSession(ctx.identityId, { step: 'when', state: { ...state, district: text } });
    await send(ctx, UI.askWhenTitle, maxWhenButtons());
    return;
  }

  if (step === 'when' && state.whenLabel === 'custom') {
    const newState: SessionState = { ...state, whenHuman: text, whenLabel: 'custom', whenCustom: text };
    if (funnel === 'repeat' && state.activeLeadId) {
      const today = new Date().toISOString().slice(0,10);
      await finishRepeatOrder(ctx, { ...newState, whenFrom: today, whenTo: today });
      return;
    }
    if (funnel === 'edit_date' && state.activeLeadId) {
      const today = new Date().toISOString().slice(0,10);
      await finishEditDate(ctx, newState, { from: today, to: today, human: text });
      return;
    }
    await renderConfirm(ctx, newState);
    return;
  }

  await send(ctx, UI.help, menuButtonsFor(ctx));
}
