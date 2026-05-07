import { env } from './env';

const TG_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

export type InlineButton = { text: string; callback_data: string };

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: {
    id: string;
    from: TgUser;
    message?: TgMessage;
    data?: string;
  };
};

export type TgUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string; first_name?: string; last_name?: string; username?: string };
  date: number;
  text?: string;
  contact?: { phone_number: string; first_name?: string; last_name?: string; user_id?: number };
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  location?: { latitude: number; longitude: number };
};

export async function tgRequest<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.error_code} ${json.description}`);
  }
  return json.result as T;
}

export function sendMessage(chatId: number | string, text: string, opts: {
  parse_mode?: 'HTML' | 'MarkdownV2';
  reply_markup?: unknown;
  disable_web_page_preview?: boolean;
} = {}) {
  return tgRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode ?? 'HTML',
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    reply_markup: opts.reply_markup,
  });
}

export function answerCallbackQuery(id: string, text?: string) {
  return tgRequest('answerCallbackQuery', { callback_query_id: id, text });
}

export function inlineKeyboard(rows: InlineButton[][]) {
  return { inline_keyboard: rows };
}

export function replyKeyboardRequestContact(text = 'Поделиться номером') {
  return {
    keyboard: [[{ text, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

export function removeKeyboard() {
  return { remove_keyboard: true };
}

// Главное меню
export function mainMenuKeyboard() {
  return inlineKeyboard([
    [{ text: '🌱 Покос газона',          callback_data: 'svc:lawn_mowing' }],
    [{ text: '🌿 Скарификация / аэрация', callback_data: 'svc:scarification' }],
    [{ text: '🪓 Расчистка участка',      callback_data: 'svc:land_clearing' }],
    [{ text: '🏊 Чистка / сборка бассейна', callback_data: 'svc:pool_cleaning' }],
    [{ text: '☎️ Связаться с оператором', callback_data: 'op:contact' }],
  ]);
}
