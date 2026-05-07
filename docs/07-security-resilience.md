# 07. Безопасность, анти-спам, устойчивость

## 7.1. Лимиты и анти-спам

### Telegram

- Глобальный лимит — 30 сообщений/секунду суммарно по всему боту. Лимит
  на одного пользователя — 1 сообщение/секунду в обычных диалогах.
- Для рассылок держим *существенно* ниже: 1 сообщение в 1–2 секунды на батч в
  20 получателей. Это даёт ~10–20 msg/s — безопасно.
- Конфигурация в n8n: SplitInBatches (`batchSize: 20`) → Wait (`amount: 1s`).

### MAX

- В Bot API MAX лимиты официально не публикуются. Закладываем: 10 msg/s,
  батч 15, Wait 2s.
- Если попадаем на 429 (Rate Limit) — ловим в n8n IF-узле по `$json.statusCode`,
  делаем Wait 30s и повторяем батч.

### На стороне БД

- `consent_marketing = true` — обязательное условие для рассылки (выставляется
  пользователем явно, например в финале первой воронки или отдельной кнопкой).
- `unsubscribed = true` — жёсткий стоп. Команды бота: `стоп`, `отписаться`,
  `unsubscribe`. RPC `unsubscribe_contact` обновляет флаг и пишет
  событие `contact.unsubscribed`.
- Все сегмент-RPC уже фильтруют `unsubscribed = false AND consent_marketing = true`.
- `is_blocked = true` в `contact_identities` — пользователь заблокировал бот.
  Ставится автоматически: при попытке отправить сообщение получаем
  Telegram error `403: Forbidden: bot was blocked by the user` → n8n должен
  обновлять флаг.

### Сегмент-фильтры от частых рассылок

В RPC `segment_for_recurring_lawn_mowing` уже есть:

```sql
and not exists (
  select 1 from campaign_sent cs
   where cs.contact_id = c.id and cs.channel = ci.channel
)
```

где `campaign_sent` — последние 20 дней по этой кампании. То есть один и тот
же клиент не получит повторное напоминание чаще, чем раз в 20 дней.

## 7.2. Идемпотентность

### Входящие апдейты

- Перед основной обработкой делаем `INSERT INTO webhook_inbox (channel,
  external_id, payload)`. Уникальный индекс `(channel, external_id)` → если
  апдейт уже видели, получаем `unique_violation`, возвращаем 200 и выходим.
  См. `lib/supabase.ts → isInboxDuplicate()`.
- Если обработка упала — пишем `error` в `webhook_inbox.error`, но всё равно
  возвращаем 200 — Telegram/MAX **не нужно** ретраить логические ошибки на нашей
  стороне.

### Исходящие сообщения

- При вставке в `messages` выставляем `external_id` (`message_id`).
  Уникальный индекс `(channel, direction, external_id)` гарантирует, что
  повторная попытка записать тот же исходящий — не задвоит лог.

### Кампании

- В `campaign_recipients` уникальный `(campaign_id, contact_id, channel)`.
  Запрос всегда `INSERT ... ON CONFLICT (...) DO UPDATE SET status='sent', sent_at=now()`.

### create_lead vs дубль заявки

- Если пользователь дважды отправил «телефон» (двойной клик в Telegram), то
  Vercel за два апдейта зайдёт в обработчик дважды. Защита первого уровня —
  `webhook_inbox`. Второго — на финальном шаге проверяем
  `bot_sessions.step != 'done'` (если уже `done`, новую заявку не создаём).

## 7.3. Логирование ошибок

### В Supabase (`app_logs`)

- `lib/supabase.ts → logToDb(level, source, message, context)`.
- Vercel-функция при любой ошибке пишет `level='error'`.
- n8n-Workflow пишет в ту же таблицу через Postgres node (settings → Error
  Workflow).

### В Telegram

- Воркфлоу `04-error-watch.json` каждые 5 минут читает `app_logs` за
  последние 6 минут с `level='error'` и шлёт в `TELEGRAM_OWNER_CHAT_ID`.
- Альтернатива: Sentry. В этом случае добавить `SENTRY_DSN` в env и
  подключить `@sentry/serverless` в `lib/supabase.ts` (опционально).

## 7.4. Rate-limiting на нашей стороне

В Vercel-функциях минимальный bucket-limit на IP не нужен (Telegram/MAX —
доверенные источники, проверяем secret). Но защита от того, чтобы ботом не
гонять одну и ту же команду:

- `bot_sessions.expires_at` — если пользователь начал сессию и пропал, через
  N часов мы можем сбрасывать состояние. n8n cron раз в час:
  ```sql
  delete from bot_sessions where expires_at < now();
  ```

## 7.5. Секреты

- `SUPABASE_SERVICE_ROLE_KEY` — **только** на сервере (Vercel env, n8n
  credentials). Никогда не возвращать в API ответах.
- `TELEGRAM_WEBHOOK_SECRET` — генерируется один раз: `openssl rand -hex 32`.
  Записывается в `Vercel env` и в `setWebhook?secret_token=`.
- `N8N_INBOUND_SECRET` — тоже `openssl rand -hex 32`. Записывается в Vercel
  env и в n8n env (через Variables или env-файл).
- Каждый секрет ротируется минимум раз в 6 месяцев. Алгоритм:
  1. Сгенерили новый.
  2. Положили рядом со старым в env (например, `_OLD` суффикс).
  3. Обновили вебхук Telegram setWebhook с новым.
  4. Перевыпустили токен n8n.
  5. Удалили `_OLD`.

## 7.6. RLS

- `service_role` обходит RLS — это нормальная практика для серверных
  функций.
- Anon-клиенту доступен только `services` (на чтение, для будущей витрины).
- В будущем, когда появится админка с Supabase Auth (роль `authenticated`),
  добавить политики:
  ```sql
  create policy "auth read leads" on public.leads
    for select to authenticated using (auth.uid() in (
      select id from auth.users where raw_user_meta_data->>'role' = 'admin'
    ));
  ```

## 7.7. Бэкапы

- Supabase Free tier — точечные бэкапы только в платных тарифах.
- На Pro тарифе включить Daily backups + Point-in-time recovery (7 дней).
- Дополнительно: раз в день экспорт критичных таблиц в S3 (n8n cron):
  ```sql
  copy (select * from public.contacts) to stdout with csv header;
  copy (select * from public.leads) to stdout with csv header;
  ```
  → загружать в Yandex Object Storage / S3-совместимое.

## 7.8. Чек-лист перед запуском в прод

- [ ] Все секреты в Vercel env заведены, в production не пересекаются с dev.
- [ ] `TELEGRAM_BOT_TOKEN` у prod — отдельный бот.
- [ ] Миграции применены (`/api/admin/health` → 200).
- [ ] Webhook Telegram зарегистрирован на prod-URL (`getWebhookInfo`).
- [ ] Webhook MAX зарегистрирован.
- [ ] n8n-воркфлоу импортированы и активированы (`active: true`).
- [ ] В `campaigns` соответствующие кампании отметить `is_active = true`
      когда готовы стартовать рассылки.
- [ ] Тестовый прогон: написать боту `/start`, дойти до `done`, увидеть
      запись в `leads` и нотификацию в `TELEGRAM_OWNER_CHAT_ID`.
- [ ] `app_logs` пустые от ошибок последние 30 минут.
