# Premium — Лидогенерация в мессенджерах (Telegram + MAX)

Архитектура и эталонная реализация экосистемы лидогенерации для B2C-услуг
(покос газона, скарификация/аэрация, расчистка участков, чистка/сборка
бассейнов) в России.

Стек:

- **Supabase** — Postgres + REST/RPC + Auth (база лидов, контактов, услуг,
  кампаний, логов).
- **n8n** — оркестратор: вебхуки, триггеры, рассылки, нотификации.
- **Vercel** — serverless-функции: вебхуки Telegram/MAX, тонкий API-слой,
  будущая админ-панель.
- **Telegram Bot API** + **MAX Bot API** — каналы коммуникации с клиентом.

Регион: РФ, ориентир — Омск и область.

## Структура репозитория

```
.
├── README.md                       # этот файл
├── docs/                           # полная архитектурная документация
│   ├── 01-data-model.md            # модель данных и Supabase
│   ├── 02-n8n.md                   # n8n: воркфлоу и ноды
│   ├── 03-telegram-bot.md          # Telegram-бот на Vercel
│   ├── 04-max-bot.md               # MAX-бот на Vercel
│   ├── 05-funnels.md               # воронки и триггерные сценарии
│   ├── 06-vercel-deploy.md         # переменные окружения и деплой
│   └── 07-security-resilience.md   # безопасность, анти-спам, устойчивость
├── supabase/
│   ├── migrations/                 # SQL-миграции для Supabase CLI
│   └── seed/                       # справочники: услуги, источники, шаблоны
├── api/                            # Vercel serverless functions
│   ├── telegram/webhook.ts         # вебхук Telegram
│   ├── max/webhook.ts              # вебхук MAX
│   ├── n8n/lead-created.ts         # внутренний прокси в n8n
│   └── admin/health.ts             # health-check
├── lib/                            # общие модули (supabase client, utils)
│   ├── supabase.ts
│   ├── telegram.ts
│   ├── max.ts
│   ├── n8n.ts
│   ├── funnels.ts                  # state machine воронок
│   └── verify.ts                   # проверка подписей вебхуков
├── n8n/
│   ├── workflows/                  # экспортированные JSON-workflow для импорта
│   └── docs/                       # описание нод и маппингов
├── .github/workflows/
│   └── supabase-migrate.yml        # CI: применение миграций при merge в main
├── scripts/
│   ├── set-telegram-webhook.sh
│   └── set-max-webhook.sh
├── .env.example
├── vercel.json
├── package.json
└── tsconfig.json
```

## Быстрый старт (one-button-deploy подход)

1. **Supabase**
   - Создать проект в Supabase, забрать `Project URL`, `anon key`,
     `service_role key`, пароль БД и project ref.
   - Локально: `npm i -g supabase` → `supabase login` → `supabase link
     --project-ref <ref>` → `supabase db push`.
   - Либо: положить секреты в GitHub Actions, при merge в main миграции
     применятся автоматически (см. `.github/workflows/supabase-migrate.yml`).

2. **n8n**
   - Поднять n8n на отдельном VPS (Hetzner/Render/Railway), не на Vercel.
   - Импортировать workflow из `n8n/workflows/`.
   - Прописать credentials: Postgres (Supabase direct connection),
     Telegram API, MAX API, секреты вебхуков.

3. **Vercel**
   - Создать проект, привязать к этому репозиторию, ветка `main`.
   - Перенести переменные из `.env.example` в Vercel Environment Variables
     (production / preview / development).
   - После первого деплоя:
     - выполнить `scripts/set-telegram-webhook.sh`,
     - выполнить `scripts/set-max-webhook.sh`.

4. **Боты**
   - Telegram: создать бота через `@BotFather`, забрать `TELEGRAM_BOT_TOKEN`.
   - MAX: создать бота через `@MasterBot` в MAX, забрать `MAX_BOT_TOKEN`.

Дальше — см. `docs/`.

## Основные потоки

```
[Пользователь Telegram/MAX]
        │
        │ webhook (Bot API → Vercel)
        ▼
[Vercel /api/telegram/webhook] ──── (быстрый ответ + state в Supabase)
[Vercel /api/max/webhook]      ────────────────────────────────┐
        │                                                       │
        │ POST на N8N_WEBHOOK_URL                                │
        ▼                                                       │
[n8n: webhook → upsert contact/lead → notify owner]             │
        │                                                       │
        ▼                                                       ▼
[Supabase: contacts, leads, events, messages, logs]
        ▲
        │ Cron-триггеры (повторный покос, сезонная скарификация и т.д.)
        │
[n8n: cron → SQL выборка → SplitInBatches → Telegram/MAX рассылка]
```

## Сервисы и сезонность

| Услуга                          | Сезон (Омск)        | Триггеры рассылок          |
|--------------------------------|---------------------|----------------------------|
| Покос газона                    | май – сентябрь      | каждые 10–14 дней          |
| Скарификация/аэрация            | апрель–май, сентябрь | старт сезона, осенью       |
| Расчистка участка / спил        | круглый год         | весна (старт), осень       |
| Чистка/сборка бассейнов         | май – сентябрь      | старт сезона, консервация  |

Подробности — в `docs/05-funnels.md`.
