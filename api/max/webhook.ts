import type { VercelRequest, VercelResponse } from '@vercel/node';
import { MaxUpdate, sendMaxMessage, maxMainMenuButtons } from '../../lib/max';
import { env } from '../../lib/env';
import { verifyHmac } from '../../lib/verify';
import {
  upsertContactByIdentity, createLead, logMessage,
  getOrCreateSession, updateSession, isInboxDuplicate,
  markInboxProcessed, logToDb, supabaseAdmin,
} from '../../lib/supabase';
import { notifyN8n } from '../../lib/n8n';
import { TEXT, parseArea, promptForStep, type Step } from '../../lib/funnels';
import type { ServiceKind } from '../../lib/supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // 1. Верификация. У MAX точная схема может отличаться: либо HMAC-подпись
  //    в заголовке, либо общий секрет в URL. Здесь — пример с HMAC.
  const sig = req.headers['x-max-signature'] as string | undefined;
  const raw = JSON.stringify(req.body ?? {});
  if (env.MAX_WEBHOOK_SECRET && !verifyHmac(env.MAX_WEBHOOK_SECRET, raw, sig)) {
    await logToDb('warn', 'vercel:max-webhook', 'Bad signature', {});
    res.status(401).send('Unauthorized');
    return;
  }

  const update = req.body as MaxUpdate;
  if (!update || !update.update_type) {
    res.status(400).send('Bad payload');
    return;
  }

  // 2. external_id для идемпотентности
  const externalId =
    update.message?.body?.mid ??
    update.callback?.callback_id ??
    `${update.update_type}:${update.timestamp}`;

  const dup = await isInboxDuplicate('max', externalId, update);
  if (dup) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  notifyN8n(env.N8N_MAX_WEBHOOK_URL || env.N8N_WEBHOOK_URL, {
    type: 'max.update', update,
  });

  try {
    if (update.update_type === 'message_created' && update.message)  await onMaxMessage(update.message);
    if (update.update_type === 'message_callback' && update.callback) await onMaxCallback(update.callback);

    await markInboxProcessed('max', externalId);
    res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logToDb('error', 'vercel:max-webhook', msg, { externalId });
    await markInboxProcessed('max', externalId, msg);
    res.status(200).json({ ok: false, error: msg });
  }
}

async function onMaxMessage(m: NonNullable<MaxUpdate['message']>) {
  const userId = m.sender.user_id;
  const chatId = m.recipient.chat_id ?? userId;
  const text = (m.body.text ?? '').trim();

  const { contact_id, identity_id } = await upsertContactByIdentity({
    channel: 'max',
    externalId: String(userId),
    username: m.sender.username,
    displayName: m.sender.name,
    fullName: m.sender.name,
    sourceCode: 'max_bot',
  });

  await logMessage({
    channel: 'max', direction: 'inbound', externalId: m.body.mid,
    contactId: contact_id, kind: 'text', text, payload: m as unknown as Record<string, unknown>,
  });

  const session = await getOrCreateSession(identity_id, 'max');

  if (text === '/start' || text.toLowerCase() === 'меню') {
    await updateSession(identity_id, { funnel: 'main', step: 'service', state: {} });
    await sendMaxMessage({
      userId, chatId,
      text: TEXT.welcome(m.sender.name),
      buttons: maxMainMenuButtons(),
    });
    return;
  }

  if (/^(стоп|отписаться|stop)$/i.test(text)) {
    await supabaseAdmin().rpc('unsubscribe_contact', {
      p_contact_id: contact_id, p_reason: 'user_request',
    });
    await sendMaxMessage({ userId, chatId, text: '🚫 Вы отписаны от рассылок.' });
    return;
  }

  await advanceMaxFunnel({
    userId, chatId, identityId: identity_id, contactId: contact_id,
    step: session.step as Step,
    state: session.state as Record<string, unknown>,
    serviceKind: (session.state as { serviceKind?: ServiceKind }).serviceKind,
    text,
  });
}

async function onMaxCallback(cb: NonNullable<MaxUpdate['callback']>) {
  const userId = cb.user.user_id;
  const data = cb.payload;

  const { contact_id, identity_id } = await upsertContactByIdentity({
    channel: 'max',
    externalId: String(userId),
    username: cb.user.username,
    displayName: cb.user.name,
    fullName: cb.user.name,
    sourceCode: 'max_bot',
  });

  if (data === 'op:contact') {
    await updateSession(identity_id, { funnel: 'operator', step: 'phone', state: {} });
    await sendMaxMessage({ userId, text: TEXT.operator });
    return;
  }

  if (data.startsWith('svc:')) {
    const kind = data.slice(4) as ServiceKind;
    await updateSession(identity_id, { funnel: kind, step: 'area', state: { serviceKind: kind } });
    await sendMaxMessage({ userId, text: TEXT.serviceSelected(kind) });
  }
}

async function advanceMaxFunnel(args: {
  userId: number; chatId?: number;
  identityId: string; contactId: string;
  step: Step; state: Record<string, unknown>;
  serviceKind?: ServiceKind; text: string;
}) {
  const { userId, chatId, identityId, contactId, text } = args;
  const state = { ...args.state };
  const kind = args.serviceKind ?? (state.serviceKind as ServiceKind | undefined);

  switch (args.step) {
    case 'service':
      await sendMaxMessage({ userId, chatId, text: 'Выберите услугу:', buttons: maxMainMenuButtons() });
      return;

    case 'area': {
      const a = parseArea(text);
      if (!a) {
        await sendMaxMessage({ userId, chatId, text: 'Напишите площадь, например «8 соток» или «400 м²».' });
        return;
      }
      state.area = a.value; state.areaUnit = a.unit;
      await updateSession(identityId, { step: 'district', state });
      await sendMaxMessage({ userId, chatId, text: promptForStep('district') });
      return;
    }

    case 'district':
      state.district = text;
      await updateSession(identityId, { step: 'description', state });
      await sendMaxMessage({ userId, chatId, text: promptForStep('description') });
      return;

    case 'description':
      state.description = text;
      await updateSession(identityId, { step: 'date', state }); // у MAX-бота фото пропустим в MVP
      await sendMaxMessage({ userId, chatId, text: promptForStep('date') });
      return;

    case 'date':
      state.desiredDate = text;
      await updateSession(identityId, { step: 'phone', state });
      await sendMaxMessage({ userId, chatId, text: promptForStep('phone') });
      return;

    case 'phone': {
      const phone = text.replace(/[^\d+]/g, '');
      if (phone.length < 7) {
        await sendMaxMessage({ userId, chatId, text: 'Пожалуйста, отправьте номер телефона цифрами.' });
        return;
      }
      state.phone = phone;
      if (!kind) {
        await sendMaxMessage({ userId, chatId, text: TEXT.unknown, buttons: maxMainMenuButtons() });
        return;
      }
      const leadId = await createLead({
        contactId, serviceKind: kind, channel: 'max',
        description: state.description as string | undefined,
        areaValue: state.area as number | undefined,
        areaUnit: state.areaUnit as string | undefined,
        district: state.district as string | undefined,
        metadata: { desiredDate: state.desiredDate, phone },
      });
      await updateSession(identityId, { step: 'done', state: {}, funnel: 'main' });
      await sendMaxMessage({ userId, chatId, text: TEXT.thanks(kind) });

      notifyN8n(env.N8N_WEBHOOK_URL, {
        type: 'lead.created', leadId, contactId, serviceKind: kind, channel: 'max',
      });
      return;
    }

    case 'done':
      await sendMaxMessage({ userId, chatId, text: 'Чтобы оформить ещё заявку — напишите /start.', buttons: maxMainMenuButtons() });
      return;
  }
}
