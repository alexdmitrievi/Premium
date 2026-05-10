// Минимальный клиент MAX Bot API.
// Документация: https://dev.max.ru/docs (актуальные эндпоинты могут отличаться).
// Поэтому базовый URL вынесен в env (MAX_API_URL).

import { env } from './env';

export type MaxUpdate = {
  update_type: 'message_created' | 'message_callback' | string;
  timestamp: number;
  message?: MaxMessage;
  callback?: { callback_id: string; payload: string; user: MaxUser };
};

export type MaxUser = {
  user_id: number;
  name?: string;
  username?: string;
  is_bot?: boolean;
};

export type MaxMessage = {
  body: { mid: string; seq: number; text?: string; attachments?: unknown[] };
  recipient: { chat_id?: number; user_id?: number; chat_type?: string };
  sender: MaxUser;
  timestamp: number;
};

async function maxRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, env.MAX_API_URL);
  url.searchParams.set('access_token', env.MAX_BOT_TOKEN);
  const res = await fetch(url.toString(), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MAX ${path} ${res.status}: ${txt}`);
  }
  return (await res.json()) as T;
}

export type MaxButton = { type: 'callback' | 'link'; text: string; payload?: string; url?: string };

// MAX не рендерит HTML — стрипаем теги, чтобы пользователь не видел сырые `<b>...</b>`.
function stripHtml(s: string): string {
  return s.replace(/<\/?(?:b|i|u|s|code|pre|a)(?:\s[^>]*)?>/gi, '');
}

export function sendMaxMessage(params: {
  chatId?: number;
  userId?: number;
  text: string;
  buttons?: MaxButton[][];
}) {
  const body: Record<string, unknown> = { text: stripHtml(params.text) };
  if (params.buttons && params.buttons.length > 0) {
    body.attachments = [{
      type: 'inline_keyboard',
      payload: { buttons: params.buttons },
    }];
  }
  const qs = new URLSearchParams();
  if (params.chatId) qs.set('chat_id', String(params.chatId));
  if (params.userId) qs.set('user_id', String(params.userId));

  return maxRequest(`/messages?${qs.toString()}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// MAX — выбор типа клиента (B2C / B2B) на первом /start.
export function maxCustomerTypeButtons(): MaxButton[][] {
  return [[
    { type: 'callback', text: 'Для частного дома',         payload: 'ctype:b2c' },
    { type: 'callback', text: 'Для компании / стройки',    payload: 'ctype:b2b' },
  ]];
}

// MAX — главное меню B2C (без декоративных эмодзи — строгий стиль платформы).
export function maxMainMenuB2cButtons(): MaxButton[][] {
  return [
    [
      { type: 'callback', text: 'Покос газона',           payload: 'svc:lawn_mowing' },
      { type: 'callback', text: 'Скарификация',           payload: 'svc:scarification' },
    ],
    [
      { type: 'callback', text: 'Расчистка участка',      payload: 'svc:land_clearing' },
      { type: 'callback', text: 'Бассейн',                payload: 'svc:pool_cleaning' },
    ],
    [
      { type: 'callback', text: 'Мои заказы',             payload: 'nav:orders' },
      { type: 'callback', text: 'Пригласить друга',       payload: 'nav:referral' },
    ],
    [
      { type: 'callback', text: 'Помощь',                 payload: 'nav:help' },
      { type: 'callback', text: 'Оператор',               payload: 'nav:operator' },
    ],
  ];
}

// MAX — главное меню B2B.
export function maxMainMenuB2bButtons(): MaxButton[][] {
  return [
    [{ type: 'callback', text: 'Связаться с менеджером', payload: 'nav:operator' }],
    [
      { type: 'callback', text: 'Покос газона',          payload: 'svc:lawn_mowing' },
      { type: 'callback', text: 'Расчистка участка',     payload: 'svc:land_clearing' },
    ],
    [
      { type: 'callback', text: 'Спил / пни',            payload: 'svc:tree_cutting' },
      { type: 'callback', text: 'Вывоз мусора',          payload: 'svc:debris_removal' },
    ],
    [
      { type: 'callback', text: 'Мои заказы',            payload: 'nav:orders' },
      { type: 'callback', text: 'Помощь',                payload: 'nav:help' },
    ],
    [{ type: 'callback', text: 'Сменить тип клиента',    payload: 'nav:reset_ctype' }],
  ];
}

// Алиас для обратной совместимости (по умолчанию — B2C).
export function maxMainMenuButtons(): MaxButton[][] {
  return maxMainMenuB2cButtons();
}

export function maxAreaBucketsButtons(scope: 'lawn' | 'land' | 'pool' = 'lawn'): MaxButton[][] {
  return [
    [
      { type: 'callback', text: 'до 5 соток', payload: `area:${scope}:5`  },
      { type: 'callback', text: '5–10',        payload: `area:${scope}:10` },
    ],
    [
      { type: 'callback', text: '10–20',       payload: `area:${scope}:20` },
      { type: 'callback', text: '20+',         payload: `area:${scope}:30` },
    ],
    [{ type: 'callback', text: 'Указать вручную', payload: `area:${scope}:custom` }],
    [{ type: 'callback', text: 'В меню',           payload: 'nav:home' }],
  ];
}

export function maxDistrictButtons(): MaxButton[][] {
  return [
    [
      { type: 'callback', text: 'Чкаловский',  payload: 'dist:chkalovskiy' },
      { type: 'callback', text: 'Кировский',   payload: 'dist:kirovskiy' },
    ],
    [
      { type: 'callback', text: 'Ленинский',   payload: 'dist:leninskiy' },
      { type: 'callback', text: 'Октябрьский', payload: 'dist:oktyabrskiy' },
    ],
    [
      { type: 'callback', text: 'Советский',   payload: 'dist:sovetskiy' },
      { type: 'callback', text: 'Другой',      payload: 'dist:other' },
    ],
    [{ type: 'callback', text: 'Назад', payload: 'back' }],
  ];
}

export function maxWhenButtons(): MaxButton[][] {
  return [
    [
      { type: 'callback', text: 'Сегодня',         payload: 'when:today' },
      { type: 'callback', text: 'Завтра',          payload: 'when:tomorrow' },
    ],
    [
      { type: 'callback', text: 'Эти выходные',    payload: 'when:weekend' },
      { type: 'callback', text: 'На этой неделе',  payload: 'when:thisweek' },
    ],
    [{ type: 'callback', text: 'Другая дата',      payload: 'when:custom' }],
    [{ type: 'callback', text: 'Назад',            payload: 'back' }],
  ];
}

export function maxConfirmButtons(): MaxButton[][] {
  return [
    [{ type: 'callback', text: 'Подтвердить',      payload: 'confirm:ok' }],
    [
      { type: 'callback', text: 'Изменить дату',   payload: 'edit:when' },
      { type: 'callback', text: 'Изменить район',  payload: 'edit:district' },
    ],
    [{ type: 'callback', text: 'Отменить',         payload: 'confirm:cancel' }],
  ];
}

export function maxPostOrderButtons(): MaxButton[][] {
  return [
    [{ type: 'callback', text: 'Мои заказы',       payload: 'nav:orders' }],
    [{ type: 'callback', text: 'Пригласить друга', payload: 'nav:referral' }],
    [{ type: 'callback', text: 'В меню',           payload: 'nav:home' }],
  ];
}

export function maxOrderCardButtons(opts: {
  leadId: string; canEditDate: boolean; canCancel: boolean; isCompleted: boolean;
}): MaxButton[][] {
  const rows: MaxButton[][] = [];
  if (opts.canEditDate && !opts.isCompleted) {
    rows.push([{ type: 'callback', text: 'Изменить дату', payload: `lead:edit_date:${opts.leadId}` }]);
  }
  rows.push([{ type: 'callback', text: 'Связаться',       payload: `lead:contact:${opts.leadId}` }]);
  rows.push([{ type: 'callback', text: 'Повторить такой же', payload: `lead:repeat:${opts.leadId}` }]);
  if (opts.canCancel && !opts.isCompleted) {
    rows.push([{ type: 'callback', text: 'Отменить',      payload: `lead:cancel:${opts.leadId}` }]);
  }
  return rows;
}

export function maxReferralButtons(shareLink: string): MaxButton[][] {
  return [
    [{ type: 'link',     text: 'Поделиться ссылкой', url: shareLink }],
    [{ type: 'callback', text: 'Мои рефералы',       payload: 'nav:referral_list' }],
    [{ type: 'callback', text: 'В меню',             payload: 'nav:home' }],
  ];
}
