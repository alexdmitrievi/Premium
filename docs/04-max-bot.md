# 04. MAX-бот на Vercel

## 4.1. Архитектура

В MAX (мессенджере VK) для бота нужен токен от **MasterBot**. Цепочка:

1. В MAX найти `@MasterBot`, написать `/newbot` → получить токен.
2. Прописать токен в Vercel env как `MAX_BOT_TOKEN`.
3. Зарегистрировать вебхук (см. §4.4).

Возможны два подхода:

- **A. Прямой Bot API** через HTTP-вызовы (как в этом репозитории).
- **B. Через готовую платформу** (BotHelp, Botmother, Umnico) — они дают
  визуальный конструктор, но мы платим подпиской и теряем гибкость.

Базовый URL Bot API задан в `MAX_API_URL` (по умолчанию `https://botapi.max.ru`).
Эндпоинты, которые используются:

| Что                        | Метод и путь                                                   |
|----------------------------|----------------------------------------------------------------|
| Зарегистрировать webhook   | `POST /subscriptions?access_token=<token>`                     |
| Отправить сообщение        | `POST /messages?access_token=<token>&user_id=<u>` или `&chat_id=<c>` |
| Принять обновление         | (приходит к нам на `/api/max/webhook`)                         |

Точные сигнатуры могут отличаться по версиям — проверяйте на dev.max.ru.

## 4.2. Вариант A: прямой Bot API через Vercel

### Endpoint
```
POST https://your-app.vercel.app/api/max/webhook
```

См. `api/max/webhook.ts`. Логика:

1. Если задан `MAX_WEBHOOK_SECRET` — проверка HMAC по заголовку
   `X-MAX-Signature` (`verifyHmac(secret, rawBody, signature)`).
2. `external_id` для идемпотентности:
   - для `message_created` — `update.message.body.mid`,
   - для `message_callback` — `update.callback.callback_id`,
   - иначе — `${type}:${timestamp}`.
3. `isInboxDuplicate('max', external_id)` → 200 если дубль.
4. `notifyN8n('max.update', update)` — асинхронно.
5. Маршрутизация по `update.update_type`:
   - `message_created` → `onMaxMessage()`;
   - `message_callback` → `onMaxCallback()`.
6. `upsertContactByIdentity({ channel: 'max', externalId: user_id, ... })`.
7. Машина состояний (та же, что и у Telegram, кроме `photos` — у MAX мы в MVP
   сразу переходим к `date`).
8. На финальном шаге — `createLead()` + `notifyN8n('lead.created')`.

### Отправка сообщений из Vercel

`lib/max.ts → sendMaxMessage({ userId, chatId, text, buttons })`:

```ts
POST {MAX_API_URL}/messages?access_token={MAX_BOT_TOKEN}&user_id={u}
Content-Type: application/json
{
  "text": "🌱 Здравствуйте! ...",
  "attachments": [{
    "type": "inline_keyboard",
    "payload": { "buttons": [[{ "type": "callback", "text": "Записать", "payload": "svc:lawn_mowing" }]] }
  }]
}
```

### Отправка из n8n (HTTP Request node)

См. `n8n/workflows/02-recurring-mowing.json`, нода `HTTP (MAX send)`:

- Method: `POST`
- URL: `={{$env.MAX_API_URL}}/messages?access_token={{$env.MAX_BOT_TOKEN}}&user_id={{$json.external_id}}`
- Body: JSON, см. шаблон выше.
- Headers: `Content-Type: application/json`.

## 4.3. Вариант B: через BotHelp / Botmother / Umnico

Когда выбрать:

- если MAX Bot API неудобен или сильно меняется,
- если нужны мультиканальные диалоги в одном окне (BotHelp поддерживает
  Telegram + MAX + WhatsApp вместе с UI оператора).

Схема:

```
MAX → BotHelp (или Umnico) → Webhook → /api/max/webhook (Vercel)
                                          │
                                          ▼
                                       Supabase (lead/contact upsert)
                                          │
                                          ▼
                                       n8n (нотификация владельцу)
                                          │
                                          ▼
                       Ответ в MAX через BotHelp Public API
```

В этом случае:

- из BotHelp на наш `/api/max/webhook` приходят свои поля; маппим:
  - `subscriber_id` (BotHelp) → `external_id` в `contact_identities`
    (с пометкой источника через `metadata`);
  - `channel = 'max'` сохраняем;
  - сообщения шлём обратно через `POST https://app.bothelp.io/api/v1/...`
    с `Authorization: Bearer BOTHELP_API_TOKEN`.
- Идентификация пользователя для рассылок — пара (`provider`,
  `provider_user_id`), хранится в `contact_identities.metadata`:
  ```json
  { "bothelp_subscriber_id": "...", "telegram_id": "...", "max_id": "..." }
  ```
- Для триггерных рассылок n8n идёт не в MAX напрямую, а вызывает
  `bothelp` (`POST /subscribers/{id}/messages`).

### Env для интеграционной платформы

```
BOTHELP_API_TOKEN=
BOTHELP_WEBHOOK_SECRET=
UMNICO_API_TOKEN=
```

## 4.4. Регистрация вебхука MAX

```bash
MAX_BOT_TOKEN="..." \
MAX_API_URL="https://botapi.max.ru" \
PUBLIC_URL="https://your-app.vercel.app" \
bash scripts/set-max-webhook.sh
```

Скрипт делает:

```
POST https://botapi.max.ru/subscriptions?access_token=<token>
{
  "url": "https://your-app.vercel.app/api/max/webhook",
  "update_types": ["message_created", "message_callback"]
}
```

## 4.5. Env-переменные для MAX

| Переменная             | Назначение                                            |
|------------------------|-------------------------------------------------------|
| `MAX_BOT_TOKEN`        | токен бота из MasterBot                               |
| `MAX_API_URL`          | базовый URL Bot API (`https://botapi.max.ru`)         |
| `MAX_WEBHOOK_SECRET`   | shared secret для HMAC-подписи входящих, если поддерживается платформой |
| `BOTHELP_API_TOKEN`    | при использовании BotHelp                             |
| `BOTHELP_WEBHOOK_SECRET` | при использовании BotHelp                           |
| `UMNICO_API_TOKEN`     | при использовании Umnico                              |

## 4.6. Идентификация пользователя для рассылок

В таблице `contact_identities` храним пару (`channel='max'`,
`external_id=<MAX user_id или BotHelp subscriber_id>`). Это и есть тот
идентификатор, по которому потом cron-воркфлоу шлёт сообщение.

Если у одного человека есть и Telegram, и MAX — у нас две строки
`contact_identities` с одним `contact_id`. Сегмент-RPC возвращает по
каждой identity отдельную запись и шлёт сообщение в свой канал.
