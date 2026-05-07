# n8n: воркфлоу проекта Premium

## Где хостить n8n

- **Не на Vercel.** n8n — это долгоживущий сервис с встроенной БД (SQLite/Postgres),
  крон-расписаниями и стейтом ран-таймов. Vercel-функции эфемерные и не
  подходят.
- **Рекомендуемые варианты:**
  - **Hetzner Cloud CX22** (~€4/мес, Falkenstein/Nuremberg) + Docker Compose.
  - **Render Background Worker** или **Railway** — быстрее запуск, дороже на длинной.
  - **VPS в РФ** (Selectel, Timeweb) — если важна задержка до серверов
    Telegram/MAX внутри РФ.
- **Подключение к Supabase:**
  - **Postgres node** через Direct connection (postgres://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres).
    Этот вариант предпочтителен для cron-выборок и массовых операций.
  - **HTTP Request node** с PostgREST для отдельных операций
    (`https://<ref>.supabase.co/rest/v1/...` + header `apikey: SERVICE_ROLE_KEY`).
  - **Supabase node** (community) — удобно, но привязка к версии.

## Credentials, которые нужно создать в n8n

| Имя credential   | Тип               | Что вписать                                                              |
|------------------|-------------------|---------------------------------------------------------------------------|
| `Supabase (direct)` | Postgres        | host=`db.<ref>.supabase.co`, port=5432, db=postgres, user=postgres, password=`SUPABASE_DB_PASSWORD`, ssl=true |
| `Telegram Main Bot` | Telegram API    | token=`TELEGRAM_BOT_TOKEN` (тот же, что в Vercel)                         |
| `Telegram Owner Bot`| Telegram API    | можно тот же бот, для уведомлений мне (chat_id в env)                     |
| `MAX HTTP`          | HTTP (Header Auth) | header `Content-Type: application/json` (токен передаём в URL)         |

## Environment-переменные n8n

В файле `.env` n8n (или `Settings → Variables` в UI):

```
PREMIUM_INBOUND_SECRET=...           # тот же, что N8N_INBOUND_SECRET в Vercel
TELEGRAM_OWNER_CHAT_ID=123456789
MAX_BOT_TOKEN=...
MAX_API_URL=https://botapi.max.ru
```

## Воркфлоу из репозитория

| Файл                              | Что делает                                                       | Триггер                 |
|----------------------------------|------------------------------------------------------------------|-------------------------|
| `01-lead-events.json`            | Принимает `lead.created` от Vercel, шлёт владельцу Telegram-нотификацию | Webhook (`/webhook/lead-events`) |
| `02-recurring-mowing.json`       | Раз в 2 дня: сегмент клиентов с покосом > 12 дней назад → рассылка | Cron (Пн/Ср/Пт 09:00)    |
| `03-seasonal-pool.json`          | 1 и 15 мая: рассылка владельцам бассейнов                       | Cron                    |
| `04-error-watch.json`            | Каждые 5 минут читает `app_logs.level='error'` и шлёт алерт   | Cron                    |

Импорт: `Settings → Import workflow → from file`.

## Маппинг полей

### Webhook node `lead-events`
- HTTP method: `POST`
- Path: `lead-events`
- Authentication: «None» (валидируем через header в IF-ноде)
- Response Mode: `Last node` → `Respond to Webhook`

В первом IF-узле проверяем:
```
{{$json.headers['x-premium-secret']}} === {{$env.PREMIUM_INBOUND_SECRET}}
```

### Postgres node (load lead)
- Operation: `Execute Query`
- Query: см. SQL внутри JSON
- Использовать «Use Query Parameters»: ❌ (берём из выражений)
- Привязать credential `Supabase (direct)`.

### Telegram node (send)
- Operation: `Send Message`
- Chat ID: `={{$json.external_id}}`
- Text: шаблон с `{{$json.full_name}}` и т.п.
- Additional Fields → Parse Mode: `HTML`

### HTTP Request node (MAX send)
- Method: `POST`
- URL: `={{$env.MAX_API_URL}}/messages?access_token={{$env.MAX_BOT_TOKEN}}&user_id={{$json.external_id}}`
- Body: JSON с `text` и опциональными `attachments`.

## Best practices

- В каждый рассылочный воркфлоу — **SplitInBatches** + **Wait** между батчами.
  Telegram лимит — не больше 30 сообщений в секунду суммарно, и лучше держаться
  существенно ниже (1 сообщение в 1–2 секунды одному пользователю).
- На каждом исходящем — `INSERT ... ON CONFLICT DO UPDATE` в `campaign_recipients`,
  чтобы повторный прогон не задвоил.
- Для отладки используйте **Error Workflow** (Settings → Error workflow): один
  шаренный workflow, который пишет ошибки в `public.app_logs` и шлёт алерт.
