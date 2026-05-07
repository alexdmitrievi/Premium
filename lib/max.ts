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

export function sendMaxMessage(params: {
  chatId?: number;
  userId?: number;
  text: string;
  buttons?: MaxButton[][];
}) {
  const body: Record<string, unknown> = { text: params.text };
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

export function maxMainMenuButtons(): MaxButton[][] {
  return [
    [{ type: 'callback', text: '🌱 Покос газона',          payload: 'svc:lawn_mowing' }],
    [{ type: 'callback', text: '🌿 Скарификация / аэрация', payload: 'svc:scarification' }],
    [{ type: 'callback', text: '🪓 Расчистка участка',      payload: 'svc:land_clearing' }],
    [{ type: 'callback', text: '🏊 Чистка / сборка бассейна', payload: 'svc:pool_cleaning' }],
    [{ type: 'callback', text: '☎️ Связаться с оператором', payload: 'op:contact' }],
  ];
}
