import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  TgUpdate, TgMessage, TgUser,
  sendMessage, mainMenuKeyboard, inlineKeyboard,
  replyKeyboardRequestContact, removeKeyboard, answerCallbackQuery,
  areaBucketsKeyboard, districtKeyboard, whenKeyboard, confirmKeyboard,
  postOrderKeyboard, backToHomeKeyboard, orderCardKeyboard, referralKeyboard,
} from '../../lib/telegram';
import { env } from '../../lib/env';
import { verifyTelegramSecret } from '../../lib/verify';
import {
  upsertContactByIdentity, createLead, logMessage,
  getOrCreateSession, updateSession, isInboxDuplicate,
  markInboxProcessed, logToDb, supabaseAdmin,
  type ServiceKind, type Channel,
} from '../../lib/supabase';
import { notifyN8n } from '../../lib/n8n';
import {
  UI, SERVICE_LABEL, PRICE_HINT, DISTRICTS, districtName,
  parseArea, parseAreaBucket, whenLabelToRange,
  estimatePriceRange, applyDiscountToRange, formatRub, formatDateRange,
  mapStatusToUi, canCancelStatus, canEditDateStatus,
  type SessionState,
} from '../../lib/funnels';
import {
  listMyOrders, getOrder, cancelMyOrder, updateOrderDate,
  ensureReferralCode, recordReferralVisit, getReferralStats, getReferralList,
  computeDiscount, applyDiscountToLead, repeatOrder,
} from '../../lib/orders';

const CHANNEL: Channel = 'telegram';
const SHARE_TEXT = 'Премиум — уход за участком в Омске. По ссылке +500 ₽ скидки нам обоим';

type Ctx = {
  chatId: number;
  fromUser: TgUser;
  contactId: string;
  identityId: string;
  session: { funnel: string; step: string; state: SessionState };
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const secret = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
  if (!verifyTelegramSecret(secret)) {
    await logToDb('warn', 'vercel:tg-webhook', 'Bad secret token', {});
    res.status(401).send('Unauthorized'); return;
  }

  const update = req.body as TgUpdate;
  if (!update || typeof update.update_id !== 'number') { res.status(400).send('Bad payload'); return; }

  const dup = await isInboxDuplicate(CHANNEL, String(update.update_id), update);
  if (dup) { res.status(200).json({ ok: true, duplicate: true }); return; }

  notifyN8n(env.N8N_TELEGRAM_WEBHOOK_URL || env.N8N_WEBHOOK_URL, { type: 'tg.update', update });

  try {
    if (update.message)        await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);

    await markInboxProcessed(CHANNEL, String(update.update_id));
    res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logToDb('error', 'vercel:tg-webhook', msg, { update_id: update.update_id });
    await markInboxProcessed(CHANNEL, String(update.update_id), msg);
    res.status(200).json({ ok: false, error: msg });
  }
}

// ---------------------------------------------------------------------------
// Загрузка контекста: контакт, identity, сессия
// ---------------------------------------------------------------------------
async function loadCtx(from: TgUser, chatId: number, opts: { phone?: string } = {}): Promise<Ctx> {
  const { contact_id, identity_id } = await upsertContactByIdentity({
    channel: CHANNEL,
    externalId: String(from.id),
    username: from.username,
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    fullName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    phone: opts.phone,
    sourceCode: 'telegram_bot',
  });
  const session = await getOrCreateSession(identity_id, CHANNEL);
  return {
    chatId,
    fromUser: from,
    contactId: contact_id,
    identityId: identity_id,
    session: {
      funnel: session.funnel,
      step:   session.step,
      state:  (session.state ?? {}) as SessionState,
    },
  };
}

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------
async function onMessage(m: TgMessage) {
  const fromUser = m.from ?? { id: m.chat.id, is_bot: false, first_name: m.chat.first_name ?? '' } as TgUser;
  const ctx = await loadCtx(fromUser, m.chat.id, { phone: m.contact?.phone_number });

  await logMessage({
    channel: CHANNEL, direction: 'inbound',
    externalId: `${m.chat.id}:${m.message_id}`,
    contactId: ctx.contactId,
    kind: m.photo ? 'photo' : m.contact ? 'contact' : m.location ? 'location' : 'text',
    text: m.text, payload: m as unknown as Record<string, unknown>,
  });

  const text = (m.text ?? '').trim();

  // /start ref_<code>
  const refMatch = text.match(/^\/start\s+ref_([A-Z0-9]{4,12})$/i);
  if (refMatch) {
    const code = refMatch[1]!.toUpperCase();
    const refId = await recordReferralVisit(ctx.contactId, code);
    if (refId) {
      await sendMessage(ctx.chatId, UI.referralActivated(), { reply_markup: mainMenuKeyboard() });
    } else {
      await showHome(ctx);
    }
    await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
    return;
  }

  // /start | меню | /menu
  if (text === '/start' || /^(меню|menu|\/menu)$/i.test(text)) {
    await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
    await showHome(ctx);
    return;
  }

  // Отписка
  if (/^(стоп|отписаться|stop|unsubscribe)$/i.test(text)) {
    await supabaseAdmin().rpc('unsubscribe_contact', { p_contact_id: ctx.contactId, p_reason: 'user_request' });
    await sendMessage(ctx.chatId, '🚫 Вы отписаны от рассылок. Заказы по-прежнему можно делать через меню.', {
      reply_markup: backToHomeKeyboard(),
    });
    return;
  }

  // Свободный ввод внутри текущего шага
  await advanceText(ctx, text, m);
}

// ---------------------------------------------------------------------------
// Inline-кнопки
// ---------------------------------------------------------------------------
async function onCallback(cb: NonNullable<TgUpdate['callback_query']>) {
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const data = cb.data ?? '';
  await answerCallbackQuery(cb.id);

  const ctx = await loadCtx(cb.from, chatId);

  const [scope, action, ...rest] = data.split(':');
  const arg = rest.join(':');

  switch (scope) {
    case 'svc':       return startOrder(ctx, action as ServiceKind);
    case 'area':      return setArea(ctx, action as 'lawn'|'land'|'pool', arg);
    case 'dist':      return setDistrict(ctx, action!);
    case 'when':      return setWhen(ctx, action!, arg);
    case 'confirm':   return action === 'ok' ? confirmOrder(ctx) : cancelDuringOrder(ctx);
    case 'edit':      return editField(ctx, action!);
    case 'lead':      return leadAction(ctx, action!, arg);
    case 'skip':      return skipPhotos(ctx);
    case 'back':      return showHome(ctx);
    case 'nav': {
      switch (action) {
        case 'home':           return showHome(ctx);
        case 'orders':         return showMyOrders(ctx);
        case 'referral':       return showReferral(ctx);
        case 'referral_list':  return showReferralList(ctx);
        case 'help':           return showHelp(ctx);
        case 'operator':       return showOperator(ctx);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Экраны верхнего уровня
// ---------------------------------------------------------------------------
async function showHome(ctx: Ctx) {
  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
  await sendMessage(ctx.chatId, UI.homeWelcome(ctx.fromUser.first_name));
  await sendMessage(ctx.chatId, UI.homeMenu, { reply_markup: mainMenuKeyboard() });
}

async function showHelp(ctx: Ctx) {
  await sendMessage(ctx.chatId, UI.help, { reply_markup: backToHomeKeyboard() });
}

async function showOperator(ctx: Ctx, leadId?: string) {
  await updateSession(ctx.identityId, { funnel: 'operator', step: 'phone', state: { screen: 'operator', activeLeadId: leadId } });
  await sendMessage(ctx.chatId, UI.operator, { reply_markup: replyKeyboardRequestContact('📞 Поделиться номером') });
}

async function showMyOrders(ctx: Ctx) {
  const orders = await listMyOrders(ctx.contactId, 5);
  if (orders.length === 0) {
    await sendMessage(ctx.chatId, UI.myOrdersEmpty, { reply_markup: mainMenuKeyboard() });
    return;
  }
  await sendMessage(ctx.chatId, UI.myOrdersHeader);
  for (const o of orders) {
    const ui = mapStatusToUi(o.status);
    const card = UI.orderCard({
      humanId: o.human_id,
      serviceName: o.service_name,
      statusIcon: ui.icon,
      statusLabel: ui.label,
      when: formatDateRange(o.desired_date_from, o.desired_date_to),
      district: o.district ?? undefined,
      area: o.area_value ? `${o.area_value} ${o.area_unit ?? ''}`.trim() : undefined,
      priceQuoted: o.price_quoted ?? undefined,
      discountPercent: o.discount_percent || undefined,
    });
    await sendMessage(ctx.chatId, card, {
      reply_markup: orderCardKeyboard({
        leadId: o.id,
        canEditDate: canEditDateStatus(o.status),
        canCancel: canCancelStatus(o.status),
        isCompleted: o.status === 'done' || o.status === 'lost' || o.status === 'archived',
      }),
    });
  }
  await sendMessage(ctx.chatId, '—', { reply_markup: backToHomeKeyboard() });
}

async function showReferral(ctx: Ctx) {
  const code = await ensureReferralCode(ctx.contactId);
  const stats = await getReferralStats(ctx.contactId);
  const link = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=ref_${code}`;
  await sendMessage(ctx.chatId, UI.referralIntro({
    link, invited: stats.invited, balance: stats.balance,
  }), { reply_markup: referralKeyboard(link, SHARE_TEXT) });
}

async function showReferralList(ctx: Ctx) {
  const rows = await getReferralList(ctx.contactId);
  if (rows.length === 0) {
    await sendMessage(ctx.chatId, UI.referralListEmpty, { reply_markup: backToHomeKeyboard() });
    return;
  }
  const lines = [UI.referralListHeader, ''];
  for (const r of rows) {
    lines.push(UI.referralListItem({
      name: r.invitee_name ?? 'Друг',
      status: r.status,
      date: r.qualified_at ? new Date(r.qualified_at).toLocaleDateString('ru-RU') : '',
    }));
  }
  await sendMessage(ctx.chatId, lines.join('\n'), { reply_markup: backToHomeKeyboard() });
}

// ---------------------------------------------------------------------------
// Воронка заказа
// ---------------------------------------------------------------------------
async function startOrder(ctx: Ctx, kind: ServiceKind) {
  const state: SessionState = { screen: 'order', serviceKind: kind };
  await updateSession(ctx.identityId, { funnel: 'order', step: 'params', state });
  await sendMessage(ctx.chatId, UI.orderServiceIntro(kind), { reply_markup: removeKeyboard() });
  await sendMessage(ctx.chatId, UI.askArea(kind), {
    reply_markup: areaBucketsKeyboard(scopeForKind(kind)),
  });
}

function scopeForKind(k: ServiceKind): 'lawn' | 'land' | 'pool' {
  if (k === 'pool_cleaning' || k === 'pool_assembly') return 'pool';
  if (k === 'land_clearing' || k === 'tree_cutting' || k === 'stump_removal' || k === 'debris_removal') return 'land';
  return 'lawn';
}

async function setArea(ctx: Ctx, _scope: 'lawn'|'land'|'pool', arg: string) {
  if (arg === 'custom') {
    await updateSession(ctx.identityId, { step: 'params', state: { ...ctx.session.state, areaBucket: 'custom' } });
    await sendMessage(ctx.chatId, 'Напишите площадь или объём цифрой — например, «8 соток» или «400 м²».');
    return;
  }
  const parsed = parseAreaBucket(`area:_:${arg}`);
  if (!parsed) {
    await sendMessage(ctx.chatId, 'Не распознал площадь. Попробуйте ещё раз.');
    return;
  }
  const area = parsed.max;
  const state: SessionState = {
    ...ctx.session.state, area, areaUnit: parsed.unit, areaBucket: parsed.bucket,
  };
  await updateSession(ctx.identityId, { step: 'district', state });
  await sendMessage(ctx.chatId, UI.askDistrictTitle, { reply_markup: districtKeyboard() });
}

async function setDistrict(ctx: Ctx, code: string) {
  if (code === 'other') {
    await updateSession(ctx.identityId, { step: 'district', state: { ...ctx.session.state, districtCode: 'other' } });
    await sendMessage(ctx.chatId, 'Напишите название района или посёлка одной строкой.');
    return;
  }
  const name = districtName(code) ?? code;
  const state: SessionState = { ...ctx.session.state, districtCode: code, district: name };
  await updateSession(ctx.identityId, { step: 'when', state });
  await sendMessage(ctx.chatId, UI.askWhenTitle, { reply_markup: whenKeyboard() });
}

async function setWhen(ctx: Ctx, label: string, _arg: string) {
  if (label === 'custom') {
    await updateSession(ctx.identityId, { step: 'when', state: { ...ctx.session.state, whenLabel: 'custom' } });
    await sendMessage(ctx.chatId, 'Напишите удобную дату — например, «10 мая» или «следующая суббота».');
    return;
  }
  const range = whenLabelToRange(label);
  if (!range) {
    await sendMessage(ctx.chatId, 'Не понял дату.', { reply_markup: whenKeyboard() });
    return;
  }
  const state: SessionState = {
    ...ctx.session.state,
    whenLabel: label, whenHuman: range.human, whenFrom: range.from, whenTo: range.to,
  };

  // Если повторный заказ — сразу создаём новый лид и финиш.
  if (ctx.session.funnel === 'repeat' && state.activeLeadId) {
    await finishRepeatOrder(ctx, state);
    return;
  }

  // Если редактируем дату существующего заказа
  if (ctx.session.funnel === 'edit_date' && state.activeLeadId) {
    await finishEditDate(ctx, state, range);
    return;
  }

  await updateSession(ctx.identityId, { step: 'confirm', state });
  await renderConfirm(ctx, state);
}

async function renderConfirm(ctx: Ctx, state: SessionState) {
  const kind = state.serviceKind!;
  const units = state.area ?? 1;
  const range = estimatePriceRange(kind, units);

  const { percent, bonusRub } = await computeDiscount(ctx.contactId, kind);
  const finalRange = applyDiscountToRange(range, percent, Math.min(bonusRub, 500));

  const stateWithDiscount: SessionState = { ...state, discountPercent: percent, bonusRub: Math.min(bonusRub, 500) };
  await updateSession(ctx.identityId, { step: 'confirm', state: stateWithDiscount });

  await sendMessage(ctx.chatId, UI.orderConfirm({
    service: SERVICE_LABEL[kind],
    area: state.areaBucket && state.areaBucket !== 'custom' ? bucketLabel(state.areaBucket) : (state.area ? `${state.area} ${state.areaUnit ?? ''}`.trim() : undefined),
    district: state.district,
    when: state.whenHuman,
    priceLow: range.low, priceHigh: range.high,
    discountPercent: percent || undefined,
    bonusRub: Math.min(bonusRub, 500) || undefined,
    finalLow: percent || bonusRub ? finalRange.low : undefined,
    finalHigh: percent || bonusRub ? finalRange.high : undefined,
  }), { reply_markup: confirmKeyboard() });
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
  if (field === 'when') {
    await updateSession(ctx.identityId, { step: 'when', state: ctx.session.state });
    await sendMessage(ctx.chatId, UI.askWhenTitle, { reply_markup: whenKeyboard() });
    return;
  }
  if (field === 'district') {
    await updateSession(ctx.identityId, { step: 'district', state: ctx.session.state });
    await sendMessage(ctx.chatId, UI.askDistrictTitle, { reply_markup: districtKeyboard() });
    return;
  }
}

async function cancelDuringOrder(ctx: Ctx) {
  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
  await sendMessage(ctx.chatId, 'Отменено. Возвращаю в меню.', { reply_markup: mainMenuKeyboard() });
}

async function confirmOrder(ctx: Ctx) {
  const state = ctx.session.state;
  const kind = state.serviceKind;
  if (!kind) { await showHome(ctx); return; }

  // Если телефона ещё нет в contacts — спросим
  const { data: contact } = await supabaseAdmin()
    .from('contacts').select('phone').eq('id', ctx.contactId).maybeSingle();
  if (!contact?.phone) {
    await updateSession(ctx.identityId, { step: 'phone', state });
    await sendMessage(ctx.chatId, UI.askPhoneTitle, {
      reply_markup: replyKeyboardRequestContact('📞 Поделиться номером'),
    });
    return;
  }
  await finishOrder(ctx, state, contact.phone);
}

async function finishOrder(ctx: Ctx, state: SessionState, phone: string) {
  const kind = state.serviceKind!;
  const leadId = await createLead({
    contactId: ctx.contactId,
    serviceKind: kind,
    channel: CHANNEL,
    description: state.description,
    areaValue: state.area,
    areaUnit: state.areaUnit,
    district: state.district,
    metadata: {
      desiredDate: state.whenHuman,
      whenLabel: state.whenLabel,
      whenFrom: state.whenFrom,
      whenTo: state.whenTo,
      mediaIds: state.mediaIds ?? [],
      phone,
    },
  });

  // Заполнить даты в leads напрямую (RPC create_lead не принимает даты)
  if (state.whenFrom) {
    await supabaseAdmin().from('leads').update({
      desired_date_from: state.whenFrom,
      desired_date_to: state.whenTo ?? state.whenFrom,
    }).eq('id', leadId);
  }

  // Скидка
  const percent = state.discountPercent ?? 0;
  const bonus = state.bonusRub ?? 0;
  if (percent || bonus) {
    await applyDiscountToLead(ctx.contactId, leadId, percent, bonus);
  }

  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });

  // Получим human_id для карточки успеха
  const order = await getOrder(ctx.contactId, leadId);
  await sendMessage(ctx.chatId, UI.thanksCard({
    humanId: order?.human_id ?? 'A-' + leadId.slice(0,4).toUpperCase(),
    service: SERVICE_LABEL[kind],
    when: state.whenHuman,
    district: state.district,
  }), { reply_markup: postOrderKeyboard() });

  notifyN8n(env.N8N_WEBHOOK_URL, {
    type: 'lead.created', leadId, contactId: ctx.contactId, serviceKind: kind, channel: CHANNEL,
  });
}

async function finishRepeatOrder(ctx: Ctx, state: SessionState) {
  if (!state.activeLeadId) { await showHome(ctx); return; }
  const range = whenLabelToRange(state.whenLabel ?? 'today');
  if (!range) { await showHome(ctx); return; }

  const { newLeadId, oldOrder } = await repeatOrder({
    contactId: ctx.contactId,
    oldLeadId: state.activeLeadId,
    channel: CHANNEL,
    desiredDate: { ...range, label: state.whenLabel ?? 'today' },
  });

  // авто-применение скидки
  const { percent, bonusRub } = await computeDiscount(ctx.contactId, oldOrder.service_kind);
  await applyDiscountToLead(ctx.contactId, newLeadId, percent, bonusRub);

  // финальный экран
  const order = await getOrder(ctx.contactId, newLeadId);
  const units = oldOrder.area_value ?? 1;
  const priceR = estimatePriceRange(oldOrder.service_kind, units);
  const finalR = applyDiscountToRange(priceR, percent, Math.min(bonusRub, 500));

  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });

  await sendMessage(ctx.chatId, UI.thanksRepeat({
    humanId: order?.human_id ?? 'A-' + newLeadId.slice(0, 4).toUpperCase(),
    service: SERVICE_LABEL[oldOrder.service_kind],
    when: range.human,
    discountPercent: percent || undefined,
    finalPrice: percent || bonusRub ? `${formatRub(finalR.low)}–${formatRub(finalR.high)}` : undefined,
  }), { reply_markup: postOrderKeyboard() });

  notifyN8n(env.N8N_WEBHOOK_URL, {
    type: 'lead.created', leadId: newLeadId, contactId: ctx.contactId,
    serviceKind: oldOrder.service_kind, channel: CHANNEL,
  });
}

async function finishEditDate(ctx: Ctx, state: SessionState, range: { from: string; to: string; human: string }) {
  if (!state.activeLeadId) { await showHome(ctx); return; }
  const ok = await updateOrderDate(ctx.contactId, state.activeLeadId, range);
  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
  await sendMessage(ctx.chatId,
    ok ? `✅ Дата обновлена: ${range.human}` : 'Не удалось изменить дату — возможно, заказ уже в работе.',
    { reply_markup: backToHomeKeyboard() });
}

// ---------------------------------------------------------------------------
// Действия с конкретным заказом
// ---------------------------------------------------------------------------
async function leadAction(ctx: Ctx, action: string, leadId: string) {
  if (!leadId) return;
  if (action === 'contact') return showOperator(ctx, leadId);

  if (action === 'cancel') {
    const ok = await cancelMyOrder(ctx.contactId, leadId);
    await sendMessage(ctx.chatId,
      ok ? '✅ Заказ отменён. Возвратили бонусы, если использовались.' : 'Заказ уже в работе — отменить нельзя. Свяжитесь с оператором.',
      { reply_markup: backToHomeKeyboard() });
    return;
  }

  if (action === 'repeat') {
    const old = await getOrder(ctx.contactId, leadId);
    if (!old) {
      await sendMessage(ctx.chatId, 'Заказ не найден.', { reply_markup: backToHomeKeyboard() });
      return;
    }
    await updateSession(ctx.identityId, {
      funnel: 'repeat', step: 'when',
      state: { screen: 'repeat', activeLeadId: leadId, serviceKind: old.service_kind, district: old.district ?? undefined, area: old.area_value ?? undefined, areaUnit: old.area_unit ?? undefined },
    });
    await sendMessage(ctx.chatId, UI.repeatHeader({
      service: SERVICE_LABEL[old.service_kind],
      district: old.district ?? undefined,
      area: old.area_value ? `${old.area_value} ${old.area_unit ?? ''}`.trim() : undefined,
    }), { reply_markup: whenKeyboard() });
    return;
  }

  if (action === 'edit_date') {
    const old = await getOrder(ctx.contactId, leadId);
    if (!old) return;
    await updateSession(ctx.identityId, {
      funnel: 'edit_date', step: 'when',
      state: { screen: 'edit_date', activeLeadId: leadId, serviceKind: old.service_kind },
    });
    await sendMessage(ctx.chatId, 'Когда удобно?', { reply_markup: whenKeyboard() });
    return;
  }
}

// ---------------------------------------------------------------------------
// Свободный ввод текстом (когда мы в шаге, ожидающем строки)
// ---------------------------------------------------------------------------
async function advanceText(ctx: Ctx, text: string, m: TgMessage) {
  const { funnel, step, state } = ctx.session;

  // Шаг ввода телефона (ручной)
  if (step === 'phone') {
    const phone = m.contact?.phone_number ?? text;
    if (!phone || phone.replace(/[^\d]/g, '').length < 7) {
      await sendMessage(ctx.chatId, 'Не похоже на телефон. Нажмите «Поделиться номером» или пришлите номер вручную.');
      return;
    }
    await supabaseAdmin().from('contacts').update({ phone }).eq('id', ctx.contactId).is('phone', null);

    if (funnel === 'operator') {
      await sendMessage(ctx.chatId, '✅ Номер принят. Оператор свяжется в течение 30 минут.', { reply_markup: backToHomeKeyboard() });
      await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: { screen: 'home' } });
      notifyN8n(env.N8N_WEBHOOK_URL, { type: 'message.outbound', channel: CHANNEL, chatId: String(ctx.chatId), text: 'callback_request' });
      return;
    }
    await finishOrder(ctx, state, phone);
    return;
  }

  // Шаг площади «вручную»
  if (step === 'params' && state.areaBucket === 'custom') {
    const a = parseArea(text);
    if (!a) {
      await sendMessage(ctx.chatId, 'Не понял площадь. Напишите цифру — например, «8 соток» или «400 м²».');
      return;
    }
    const newState: SessionState = { ...state, area: a.value, areaUnit: a.unit, areaBucket: undefined };
    await updateSession(ctx.identityId, { step: 'district', state: newState });
    await sendMessage(ctx.chatId, UI.askDistrictTitle, { reply_markup: districtKeyboard() });
    return;
  }

  // Шаг района «другой»
  if (step === 'district' && state.districtCode === 'other') {
    const newState: SessionState = { ...state, district: text };
    await updateSession(ctx.identityId, { step: 'when', state: newState });
    await sendMessage(ctx.chatId, UI.askWhenTitle, { reply_markup: whenKeyboard() });
    return;
  }

  // Шаг «другая дата»
  if (step === 'when' && state.whenLabel === 'custom') {
    const newState: SessionState = { ...state, whenHuman: text, whenLabel: 'custom', whenCustom: text };
    await updateSession(ctx.identityId, { step: 'confirm', state: newState });

    // если повтор / редактирование — обходим confirm
    if (funnel === 'repeat' && state.activeLeadId) {
      // используем сегодняшнюю дату как fallback диапазон
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

  // Иначе — не понимаем, показываем меню
  await sendMessage(ctx.chatId, UI.help, { reply_markup: mainMenuKeyboard() });
}

async function skipPhotos(ctx: Ctx) {
  const state = ctx.session.state;
  await updateSession(ctx.identityId, { step: 'when', state });
  await sendMessage(ctx.chatId, UI.askWhenTitle, { reply_markup: whenKeyboard() });
}

// Не используется напрямую, но оставлен на будущее — TS-силикон для PRICE_HINT
void PRICE_HINT;
void DISTRICTS;
