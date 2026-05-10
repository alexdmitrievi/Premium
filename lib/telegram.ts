import { env } from './env';

const TG_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

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

// Выбор типа клиента (показывается на первом /start, если customer_type ещё не выставлен)
export function customerTypeKeyboard() {
  return inlineKeyboard([[
    { text: '🏡 Для частного дома',         callback_data: 'ctype:b2c' },
    { text: '🏗 Для компании / стройки',    callback_data: 'ctype:b2b' },
  ]]);
}

// Главное меню для физлиц (B2C). 4 услуги + сервисные кнопки.
export function mainMenuB2cKeyboard() {
  return inlineKeyboard([
    [
      { text: '🌱 Покос',         callback_data: 'svc:lawn_mowing' },
      { text: '🌿 Скарификация',  callback_data: 'svc:scarification' },
    ],
    [
      { text: '🪓 Расчистка',     callback_data: 'svc:land_clearing' },
      { text: '🏊 Бассейн',       callback_data: 'svc:pool_cleaning' },
    ],
    [
      { text: '📋 Мои заказы',    callback_data: 'nav:orders' },
      { text: '🎁 Пригласить друга', callback_data: 'nav:referral' },
    ],
    [
      { text: '❔ Помощь',        callback_data: 'nav:help' },
      { text: '☎️ Оператор',      callback_data: 'nav:operator' },
    ],
  ]);
}

// Меню B2B — те же услуги, но первой кнопкой менеджер,
// плюс возможность сменить тип клиента, если кликнули по ошибке.
export function mainMenuB2bKeyboard() {
  return inlineKeyboard([
    [{ text: '🤝 Связаться с менеджером', callback_data: 'nav:operator' }],
    [
      { text: '🌱 Покос',         callback_data: 'svc:lawn_mowing' },
      { text: '🪓 Расчистка',     callback_data: 'svc:land_clearing' },
    ],
    [
      { text: '🪚 Спил / пни',     callback_data: 'svc:tree_cutting' },
      { text: '🚮 Вывоз мусора',   callback_data: 'svc:debris_removal' },
    ],
    [
      { text: '📋 Мои заказы',    callback_data: 'nav:orders' },
      { text: '❔ Помощь',        callback_data: 'nav:help' },
    ],
    [{ text: '🔄 Сменить тип клиента', callback_data: 'nav:reset_ctype' }],
  ]);
}

// Алиас для обратной совместимости (используется в местах, где B2C по умолчанию).
export function mainMenuKeyboard() {
  return mainMenuB2cKeyboard();
}

// Клавиатура выбора площади (для покоса/скарификации/расчистки)
export function areaBucketsKeyboard(scope: 'lawn' | 'land' | 'pool' = 'lawn') {
  return inlineKeyboard([
    [
      { text: 'до 5 соток', callback_data: `area:${scope}:5`  },
      { text: '5–10',       callback_data: `area:${scope}:10` },
    ],
    [
      { text: '10–20',      callback_data: `area:${scope}:20` },
      { text: '20+',        callback_data: `area:${scope}:30` },
    ],
    [{ text: '✏️ Указать вручную', callback_data: `area:${scope}:custom` }],
    [{ text: '◀️ В меню',         callback_data: 'nav:home' }],
  ]);
}

// Клавиатура районов
export function districtKeyboard() {
  return inlineKeyboard([
    [
      { text: 'Чкаловский',  callback_data: 'dist:chkalovskiy' },
      { text: 'Кировский',   callback_data: 'dist:kirovskiy' },
    ],
    [
      { text: 'Ленинский',   callback_data: 'dist:leninskiy' },
      { text: 'Октябрьский', callback_data: 'dist:oktyabrskiy' },
    ],
    [
      { text: 'Советский',   callback_data: 'dist:sovetskiy' },
      { text: '✏️ Другой',   callback_data: 'dist:other' },
    ],
    [{ text: '◀️ Назад', callback_data: 'back' }],
  ]);
}

// Клавиатура «Когда удобно»
export function whenKeyboard() {
  return inlineKeyboard([
    [
      { text: 'Сегодня',       callback_data: 'when:today' },
      { text: 'Завтра',        callback_data: 'when:tomorrow' },
    ],
    [
      { text: 'Эти выходные',  callback_data: 'when:weekend' },
      { text: 'На этой неделе', callback_data: 'when:thisweek' },
    ],
    [{ text: '✏️ Другая дата', callback_data: 'when:custom' }],
    [{ text: '◀️ Назад', callback_data: 'back' }],
  ]);
}

// Клавиатура подтверждения заказа
export function confirmKeyboard() {
  return inlineKeyboard([
    [{ text: '✅ Подтвердить',    callback_data: 'confirm:ok' }],
    [
      { text: '✏️ Изменить дату',   callback_data: 'edit:when' },
      { text: '✏️ Изменить район',  callback_data: 'edit:district' },
    ],
    [{ text: '❌ Отменить',       callback_data: 'confirm:cancel' }],
  ]);
}

// Клавиатура после успешного оформления
export function postOrderKeyboard() {
  return inlineKeyboard([
    [{ text: '📋 Мои заказы', callback_data: 'nav:orders' }],
    [{ text: '🎁 Пригласить друга и получить скидку', callback_data: 'nav:referral' }],
    [{ text: '🏠 В меню', callback_data: 'nav:home' }],
  ]);
}

// Кнопка возврата
export function backToHomeKeyboard() {
  return inlineKeyboard([[{ text: '🏠 В меню', callback_data: 'nav:home' }]]);
}

// Кнопки на карточке активного заказа (включаются/выключаются по статусу)
export function orderCardKeyboard(opts: {
  leadId: string;
  canEditDate: boolean;
  canCancel: boolean;
  isCompleted: boolean;
}) {
  const rows: InlineButton[][] = [];
  if (opts.canEditDate && !opts.isCompleted) {
    rows.push([{ text: '✏️ Изменить дату', callback_data: `lead:edit_date:${opts.leadId}` }]);
  }
  rows.push([{ text: '📞 Связаться', callback_data: `lead:contact:${opts.leadId}` }]);
  rows.push([{ text: '🔁 Повторить такой же', callback_data: `lead:repeat:${opts.leadId}` }]);
  if (opts.canCancel && !opts.isCompleted) {
    rows.push([{ text: '❌ Отменить', callback_data: `lead:cancel:${opts.leadId}` }]);
  }
  return inlineKeyboard(rows);
}

// Клавиатура реферального экрана
export function referralKeyboard(shareLink: string, shareText: string) {
  return inlineKeyboard([
    [{
      text: '📤 Поделиться ссылкой',
      url:  `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(shareText)}`,
    }],
    [{ text: '📋 Мои рефералы', callback_data: 'nav:referral_list' }],
    [{ text: '🏠 В меню',       callback_data: 'nav:home' }],
  ]);
}
