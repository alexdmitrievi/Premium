import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  TgUpdate, sendMessage, mainMenuKeyboard, inlineKeyboard,
  replyKeyboardRequestContact, removeKeyboard, answerCallbackQuery,
} from '../../lib/telegram';
import { env } from '../../lib/env';
import { verifyTelegramSecret } from '../../lib/verify';
import {
  upsertContactByIdentity, createLead, logMessage,
  getOrCreateSession, updateSession, isInboxDuplicate,
  markInboxProcessed, logToDb,
} from '../../lib/supabase';
import { notifyN8n } from '../../lib/n8n';
import {
  TEXT, SERVICE_LABEL, promptForStep, parseArea, type Step,
} from '../../lib/funnels';
import type { ServiceKind } from '../../lib/supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // 1. Проверка secret_token, который выставлен в setWebhook.
  const secret = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
  if (!verifyTelegramSecret(secret)) {
    await logToDb('warn', 'vercel:tg-webhook', 'Bad secret token', { ip: req.headers['x-forwarded-for'] });
    res.status(401).send('Unauthorized');
    return;
  }

  const update = req.body as TgUpdate;
  if (!update || typeof update.update_id !== 'number') {
    res.status(400).send('Bad payload');
    return;
  }

  // 2. Идемпотентность: если этот update_id уже обрабатывали — отвечаем 200 и выходим.
  const dup = await isInboxDuplicate('telegram', String(update.update_id), update);
  if (dup) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  // 3. Прокидываем сырой апдейт в n8n (асинхронно, fire-and-forget).
  //    Делаем это ДО основной логики, чтобы n8n параллельно копил аналитику.
  notifyN8n(env.N8N_TELEGRAM_WEBHOOK_URL || env.N8N_WEBHOOK_URL, {
    type: 'tg.update', update,
  });

  try {
    if (update.message)         await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);

    await markInboxProcessed('telegram', String(update.update_id));
    res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logToDb('error', 'vercel:tg-webhook', msg, { update_id: update.update_id });
    await markInboxProcessed('telegram', String(update.update_id), msg);
    // Возвращаем 200, чтобы Telegram не ретраил вечно при логических ошибках.
    res.status(200).json({ ok: false, error: msg });
  }
}

// ---------------------------------------------------------------------------
// Обработка обычных сообщений
// ---------------------------------------------------------------------------
async function onMessage(m: NonNullable<TgUpdate['message']>) {
  const chatId = m.chat.id;
  const fromId = m.from?.id ?? chatId;

  // upsert контакта
  const { contact_id, identity_id } = await upsertContactByIdentity({
    channel: 'telegram',
    externalId: String(fromId),
    username: m.from?.username,
    displayName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' '),
    fullName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' '),
    phone: m.contact?.phone_number,
    sourceCode: 'telegram_bot',
  });

  // лог входящего
  await logMessage({
    channel: 'telegram',
    direction: 'inbound',
    externalId: `${chatId}:${m.message_id}`,
    contactId: contact_id,
    kind: m.photo ? 'photo' : m.contact ? 'contact' : m.location ? 'location' : 'text',
    text: m.text,
    payload: m as unknown as Record<string, unknown>,
  });

  const session = await getOrCreateSession(identity_id, 'telegram');
  const text = (m.text ?? '').trim();

  // /start или «меню» → главное меню
  if (text === '/start' || text.toLowerCase() === 'меню') {
    await updateSession(identity_id, { funnel: 'main', step: 'service', state: {} });
    await sendMessage(chatId, TEXT.welcome(m.from?.first_name), {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // отписка
  if (/^(стоп|отписаться|stop|unsubscribe)$/i.test(text)) {
    await markUnsubscribed(contact_id);
    await sendMessage(chatId, '🚫 Вы отписаны от рассылок. Заказы по-прежнему можно делать через меню /start.');
    return;
  }

  // если мы внутри воронки — обрабатываем шаг
  await advanceFunnel({
    chatId, identityId: identity_id, contactId: contact_id,
    step: session.step as Step,
    state: session.state as Record<string, unknown>,
    serviceKind: (session.state as { serviceKind?: ServiceKind }).serviceKind,
    text,
    contactPhone: m.contact?.phone_number,
    photoFileId: m.photo?.[m.photo.length - 1]?.file_id,
  });
}

// ---------------------------------------------------------------------------
// Обработка нажатий inline-кнопок
// ---------------------------------------------------------------------------
async function onCallback(cb: NonNullable<TgUpdate['callback_query']>) {
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const data = cb.data ?? '';
  await answerCallbackQuery(cb.id);

  const { contact_id, identity_id } = await upsertContactByIdentity({
    channel: 'telegram',
    externalId: String(cb.from.id),
    username: cb.from.username,
    displayName: [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' '),
    fullName: [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' '),
    sourceCode: 'telegram_bot',
  });

  if (data === 'op:contact') {
    await updateSession(identity_id, { funnel: 'operator', step: 'phone', state: {} });
    await sendMessage(chatId, TEXT.operator, {
      reply_markup: replyKeyboardRequestContact('📞 Поделиться номером'),
    });
    return;
  }

  if (data === 'skip:photos') {
    await advanceFunnel({
      chatId, identityId: identity_id, contactId: contact_id,
      step: 'photos', state: {}, serviceKind: undefined,
      text: '__skip__', contactPhone: undefined, photoFileId: undefined,
    });
    return;
  }

  if (data.startsWith('svc:')) {
    const kind = data.slice(4) as ServiceKind;
    await updateSession(identity_id, {
      funnel: kind,
      step: 'area',
      state: { serviceKind: kind },
    });
    await sendMessage(chatId, TEXT.serviceSelected(kind), { reply_markup: removeKeyboard() });
  }
}

// ---------------------------------------------------------------------------
// Шаги воронки
// ---------------------------------------------------------------------------
async function advanceFunnel(args: {
  chatId: number; identityId: string; contactId: string;
  step: Step; state: Record<string, unknown>; serviceKind?: ServiceKind;
  text: string; contactPhone?: string; photoFileId?: string;
}) {
  const { chatId, identityId, contactId, text } = args;
  const state = { ...args.state };
  const kind = args.serviceKind ?? (state.serviceKind as ServiceKind | undefined);

  switch (args.step) {
    case 'service':
      await sendMessage(chatId, 'Выберите услугу из меню ниже:', { reply_markup: mainMenuKeyboard() });
      return;

    case 'area': {
      const a = parseArea(text);
      if (!a) {
        await sendMessage(chatId, 'Не понял площадь. Напишите цифру — например, «8 соток» или «400 м²».');
        return;
      }
      state.area = a.value;
      state.areaUnit = a.unit;
      await updateSession(identityId, { step: 'district', state });
      await sendMessage(chatId, promptForStep('district'));
      return;
    }

    case 'district':
      state.district = text;
      await updateSession(identityId, { step: 'description', state });
      await sendMessage(chatId, promptForStep('description'));
      return;

    case 'description':
      state.description = text;
      await updateSession(identityId, { step: 'photos', state });
      await sendMessage(chatId, promptForStep('photos'), {
        reply_markup: inlineKeyboard([[{ text: '⏭ Пропустить', callback_data: 'skip:photos' }]]),
      });
      return;

    case 'photos': {
      if (text === '__skip__') {
        await updateSession(identityId, { step: 'date', state });
        await sendMessage(chatId, promptForStep('date'));
        return;
      }
      const ids = (state.mediaIds as string[] | undefined) ?? [];
      if (args.photoFileId) ids.push(args.photoFileId);
      state.mediaIds = ids;
      await updateSession(identityId, { state });
      // если уже 1 фото пришло — двигаемся дальше; пользователь может прислать ещё, мы примем.
      await sendMessage(chatId, ids.length === 1
        ? 'Принял фото 👍 Можно прислать ещё или переходим дальше — напишите дату.'
        : `Принял ${ids.length} фото. Переходим: ${promptForStep('date')}`);
      await updateSession(identityId, { step: 'date', state });
      return;
    }

    case 'date':
      state.desiredDate = text;
      await updateSession(identityId, { step: 'phone', state });
      await sendMessage(chatId, promptForStep('phone'), {
        reply_markup: replyKeyboardRequestContact('📞 Поделиться номером'),
      });
      return;

    case 'phone': {
      const phone = args.contactPhone ?? text;
      if (!phone || phone.length < 7) {
        await sendMessage(chatId, 'Не похоже на телефон. Нажмите кнопку «Поделиться номером» или пришлите номер вручную.');
        return;
      }
      state.phone = phone;

      // создаём заявку
      if (!kind) {
        await sendMessage(chatId, TEXT.unknown, { reply_markup: mainMenuKeyboard() });
        return;
      }
      const leadId = await createLead({
        contactId,
        serviceKind: kind,
        channel: 'telegram',
        description: state.description as string | undefined,
        areaValue: state.area as number | undefined,
        areaUnit: state.areaUnit as string | undefined,
        district: state.district as string | undefined,
        metadata: {
          desiredDate: state.desiredDate,
          mediaIds: state.mediaIds ?? [],
          phone,
        },
      });

      await updateSession(identityId, { step: 'done', state: {}, funnel: 'main' });
      await sendMessage(chatId, TEXT.thanks(kind), { reply_markup: removeKeyboard() });

      // событие в n8n — он уведомит хозяина бизнеса и положит карточку в CRM
      notifyN8n(env.N8N_WEBHOOK_URL, {
        type: 'lead.created',
        leadId, contactId, serviceKind: kind, channel: 'telegram',
      });
      return;
    }

    case 'done':
      await sendMessage(chatId, 'Если хотите оформить ещё одну заявку — нажмите /start.', {
        reply_markup: mainMenuKeyboard(),
      });
      return;
  }
}

async function markUnsubscribed(contactId: string) {
  const { supabaseAdmin } = await import('../../lib/supabase');
  await supabaseAdmin().rpc('unsubscribe_contact', { p_contact_id: contactId, p_reason: 'user_request' });
}
