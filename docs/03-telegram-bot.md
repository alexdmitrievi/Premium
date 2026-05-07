# 03. Telegram-бот на Vercel

## 3.1. Структура диалога

### Главное меню (после `/start`)

Сообщение (HTML):

```
Здравствуйте, {имя}! 👋
Я бот «Премиум — уход за участком» в Омске.

Помогаю быстро рассчитать и заказать:
• 🌱 покос газона;
• 🌿 скарификацию и аэрацию;
• 🪓 расчистку участка, спил, вывоз мусора;
• 🏊 чистку и сборку бассейнов.

Выберите услугу — я задам пару уточняющих вопросов и передам заявку мастеру.
```

Inline-кнопки:

| Текст                            | callback_data        |
|----------------------------------|----------------------|
| 🌱 Покос газона                  | `svc:lawn_mowing`    |
| 🌿 Скарификация / аэрация        | `svc:scarification`  |
| 🪓 Расчистка участка             | `svc:land_clearing`  |
| 🏊 Чистка / сборка бассейна      | `svc:pool_cleaning`  |
| ☎️ Связаться с оператором        | `op:contact`         |

### Воронка по любой услуге (одинаковые шаги)

| Шаг          | Что спрашиваем                                           | Куда сохраняем                              |
|--------------|----------------------------------------------------------|---------------------------------------------|
| `service`    | выбор услуги (через inline-кнопки)                       | `bot_sessions.state.serviceKind` + `funnel` |
| `area`       | площадь / объём (для покоса — соток / м²)                | `bot_sessions.state.area`, `areaUnit`       |
| `district`   | район / посёлок                                          | `state.district`                            |
| `description`| свободный текст (что именно сделать, особенности)        | `state.description`                         |
| `photos`     | до 3 фото или «Пропустить»                              | `state.mediaIds[]`                          |
| `date`       | желаемая дата / диапазон (свободный текст)               | `state.desiredDate`                         |
| `phone`      | контактный телефон (request_contact или текст)           | `state.phone`                               |
| `done`       | подтверждение, создание `lead` через RPC `create_lead`  | таблица `leads` + событие `lead.created`    |

После `done`:

- сообщение клиенту с подтверждением;
- `notifyN8n('lead.created', ...)` → n8n шлёт владельцу.

### Шаблоны сообщений

```
serviceSelected:
  Отлично, оформляем «<b>{услуга}</b>».
  Ориентир по цене: {диапазон}.
  Подскажите, пожалуйста, {вопрос про площадь/количество}.

askPhotos:
  Если есть, отправьте 1–3 фото объекта. Если фото не нужны — нажмите «Пропустить».

thanks:
  Спасибо! Заявка на «{услуга}» принята ✅
  Мастер свяжется с вами в ближайший рабочий час, обычно в течение 30 минут.
```

Все тексты — в `lib/funnels.ts` (`TEXT`, `SERVICE_LABEL`, `PRICE_HINT`,
`promptForStep`).

## 3.2. Архитектура serverless-функций

Не используем Next.js, чтобы не таскать рантайм. Чистый Vercel API — каждая
функция = один TS-файл в `api/`:

```
api/
├── telegram/
│   └── webhook.ts        # POST /api/telegram/webhook
├── max/
│   └── webhook.ts        # POST /api/max/webhook
├── n8n/
│   └── lead-created.ts   # POST /api/n8n/lead-created  (внутренний прокси)
└── admin/
    └── health.ts         # GET  /api/admin/health
```

Telegram шлёт `POST` с JSON-апдейтом. Подпись secret_token приходит в
заголовке `X-Telegram-Bot-Api-Secret-Token` и проверяется
`verifyTelegramSecret()` (timing-safe сравнение).

## 3.3. Жизненный цикл одного апдейта

Из `api/telegram/webhook.ts`:

1. Метод POST? Если нет — 405.
2. Проверка `X-Telegram-Bot-Api-Secret-Token` против `TELEGRAM_WEBHOOK_SECRET`. → 401.
3. `isInboxDuplicate('telegram', update_id)` — пытаемся вставить в
   `webhook_inbox` уникальную пару. Если уже есть — отвечаем 200 и выходим.
4. Fire-and-forget `notifyN8n('tg.update', update)` — n8n параллельно собирает
   аналитику.
5. Маршрутизация:
   - `update.message` → `onMessage()`;
   - `update.callback_query` → `onCallback()`.
6. Внутри:
   - `upsertContactByIdentity()` через RPC — создаёт/обновляет контакт и identity;
   - `logMessage()` — записывает входящее в `messages`;
   - `getOrCreateSession()` → текущая `bot_sessions`;
   - `advanceFunnel()` — состояние воронки и ответ.
7. На последнем шаге воронки `createLead()` + `notifyN8n('lead.created', ...)`.
8. `markInboxProcessed()` → 200 OK.
9. Любая ошибка → `logToDb('error', ...)` + 200 OK
   (Telegram не нужно ретраить логические ошибки).

## 3.4. Установка вебхука

После первого деплоя на Vercel:

```bash
TELEGRAM_BOT_TOKEN="..." \
TELEGRAM_WEBHOOK_SECRET="..." \
PUBLIC_URL="https://your-app.vercel.app" \
bash scripts/set-telegram-webhook.sh
```

Скрипт делает:

```
POST https://api.telegram.org/bot<TOKEN>/setWebhook
{
  "url": "https://your-app.vercel.app/api/telegram/webhook",
  "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
  "allowed_updates": ["message", "edited_message", "callback_query"],
  "drop_pending_updates": true
}
```

Проверка:

```bash
curl -sS https://api.telegram.org/bot<TOKEN>/getWebhookInfo | jq
```

## 3.5. Переменные окружения для Telegram-бота

| Переменная                  | Где использовать                       | Может быть `NEXT_PUBLIC_*`? |
|-----------------------------|----------------------------------------|------------------------------|
| `TELEGRAM_BOT_TOKEN`        | Vercel-функция, n8n                    | **НЕТ** (server-only)        |
| `TELEGRAM_WEBHOOK_SECRET`   | Vercel-функция, скрипт setWebhook      | **НЕТ**                      |
| `TELEGRAM_OWNER_CHAT_ID`    | n8n (отдельный, можно проксировать)    | **НЕТ**                      |
| `SUPABASE_URL`              | Vercel-функция                         | можно (но в нашем коде только сервер) |
| `SUPABASE_ANON_KEY`         | Vercel-функция (не используется), фронт | **МОЖНО** (NEXT_PUBLIC_*)    |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel-функция, n8n                    | **НЕТ. Никогда.**            |
| `N8N_WEBHOOK_URL`           | Vercel-функция                         | **НЕТ**                      |
| `N8N_INBOUND_SECRET`        | Vercel-функция, n8n IF-нода            | **НЕТ**                      |

Поскольку мы используем чистые Vercel API без Next.js, префикс `NEXT_PUBLIC_*`
не нужен — всё доступно только серверным функциям. Если в будущем добавим
панель на Next.js, для серверных переменных не префиксировать вообще, для
клиентских — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## 3.6. Важно про идемпотентность

Telegram при 5xx-ответах ретраит апдейт. Защита у нас двойная:

1. `webhook_inbox` с уникальным `(channel, external_id=update_id)`.
2. На исходящих сообщениях используем `messages` с уникальным
   `(channel, direction, external_id)` → повторная вставка просто игнорируется.

Если Telegram прислал апдейт повторно — мы вернём 200 и не сделаем повторного
действия.

## 3.7. Пример обработчика — упрощённый минимум

См. `api/telegram/webhook.ts` целиком. Минимальная схема (для понимания):

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendMessage, mainMenuKeyboard } from '../../lib/telegram';
import { verifyTelegramSecret } from '../../lib/verify';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!verifyTelegramSecret(req.headers['x-telegram-bot-api-secret-token'] as string)) {
    return res.status(401).end();
  }

  const u = req.body;
  if (u.message?.text === '/start') {
    await sendMessage(u.message.chat.id, 'Привет!', { reply_markup: mainMenuKeyboard() });
  }
  res.status(200).json({ ok: true });
}
```

Полная версия с воронкой, идемпотентностью, RPC и `notifyN8n` — в репозитории.
