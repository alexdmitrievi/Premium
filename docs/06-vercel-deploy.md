# 06. Vercel — переменные окружения и деплой

## 6.1. Список переменных

### Supabase
| Имя                          | Прод | Preview | Dev | Описание                                    |
|------------------------------|:----:|:-------:|:---:|---------------------------------------------|
| `SUPABASE_URL`               |  ✅  |   ✅    | ✅  | URL проекта Supabase                        |
| `SUPABASE_ANON_KEY`          |  ✅  |   ✅    | ✅  | Anon key (RLS-protected)                    |
| `SUPABASE_SERVICE_ROLE_KEY`  |  ✅  |   ✅    | ✅  | **Server-only.** Обходит RLS                |
| `SUPABASE_PROJECT_REF`       |   —  |    —    |  —  | Только для CLI (не нужен Vercel-функциям)   |
| `SUPABASE_DB_PASSWORD`       |   —  |    —    |  —  | Только для миграций                         |

### Telegram
| Имя                       | Описание                                              |
|---------------------------|-------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`      | Токен из @BotFather                                  |
| `TELEGRAM_WEBHOOK_SECRET` | Любая строка, передаётся в setWebhook?secret_token   |
| `TELEGRAM_OWNER_CHAT_ID`  | Чат для нотификаций (используется в n8n, не Vercel)  |

### MAX
| `MAX_BOT_TOKEN`         | Токен из MasterBot                  |
| `MAX_API_URL`           | По умолчанию `https://botapi.max.ru`|
| `MAX_WEBHOOK_SECRET`    | HMAC-секрет для проверки входящих   |

### n8n
| `N8N_WEBHOOK_URL`            | URL вебхука n8n для общих событий                 |
| `N8N_TELEGRAM_WEBHOOK_URL`   | (опц.) отдельный URL для tg.update                |
| `N8N_MAX_WEBHOOK_URL`        | (опц.) отдельный URL для max.update               |
| `N8N_INBOUND_SECRET`         | Shared secret. Vercel шлёт в header `x-premium-secret`, n8n валидирует |

### Прочее
| `PROJECT_ENV`       | development / preview / production |
| `LOG_LEVEL`         | debug / info / warn / error        |
| `DEFAULT_TIMEZONE`  | `Asia/Omsk`                        |
| `DEFAULT_CITY`      | `Омск`                             |

### Public (если будет Next.js фронт админки)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**Никогда** не префиксуйте `NEXT_PUBLIC_*` для:
- `SUPABASE_SERVICE_ROLE_KEY`,
- `TELEGRAM_BOT_TOKEN`,
- `MAX_BOT_TOKEN`,
- `*_WEBHOOK_SECRET`, `*_INBOUND_SECRET`.

## 6.2. Что куда читается

| Переменная                    | Vercel API | n8n | Браузер (потенциально)        |
|-------------------------------|:---------:|:---:|:------------------------------|
| `SUPABASE_SERVICE_ROLE_KEY`   |    ✅     | ✅  | ❌ NEVER                      |
| `SUPABASE_ANON_KEY`           |    ✅     | ✅  | ✅ через `NEXT_PUBLIC_*` (если будет фронт) |
| `TELEGRAM_BOT_TOKEN`          |    ✅     | ✅  | ❌                            |
| `TELEGRAM_WEBHOOK_SECRET`     |    ✅     |  —  | ❌                            |
| `MAX_BOT_TOKEN`               |    ✅     | ✅  | ❌                            |
| `MAX_WEBHOOK_SECRET`          |    ✅     |  —  | ❌                            |
| `N8N_WEBHOOK_URL`             |    ✅     |  —  | ❌                            |
| `N8N_INBOUND_SECRET`          |    ✅     | ✅  | ❌                            |

## 6.3. .env.example

См. файл `.env.example` в корне репозитория.

## 6.4. Как заводить переменные в Vercel

### Через UI

1. Project → Settings → Environment Variables.
2. Для каждой переменной отметить нужные окружения: Production /
   Preview / Development.
3. Чувствительные значения (`SERVICE_ROLE_KEY`, токены ботов) ставить как
   **Secret** (Vercel шифрует).

### Через CLI

```bash
npm i -g vercel
vercel login
vercel link

# по одной
vercel env add SUPABASE_SERVICE_ROLE_KEY production
# (введёт значение интерактивно)

# bulk-import из локального .env.production
vercel env pull .env.local                    # выгрузить текущие в файл
# Vercel CLI не имеет прямого "import all", удобнее завести через UI
# или скриптом, который прочитает .env и вызовет vercel env add по очереди.
```

Пример скрипта (`scripts/vercel-env-bulk.sh`, собрать руками):

```bash
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${1:-.env.production}"
TARGET="${2:-production}"
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  echo "→ $key"
  printf '%s' "$value" | vercel env add "$key" "$TARGET" --force
done < "$ENV_FILE"
```

## 6.5. Разделение окружений

- **Development** — локальная разработка (не используется на Vercel CDN, но
  можно держать значения для `vercel dev`). Здесь: тестовый бот Telegram
  (отдельный токен!), тестовый Supabase-проект (`<ref>-staging`).
- **Preview** — каждый pull request. Тоже тестовый бот, но Supabase можно
  использовать staging. Удобно — preview-URL автоматически проставляется в
  `VERCEL_URL`, и можно регистрировать preview-вебхук временно.
- **Production** — `main`. Реальный бот, реальный Supabase.

**Важно:** `TELEGRAM_BOT_TOKEN` для prod должен быть **отдельным** ботом от
preview/dev — иначе апдейты будут уходить не туда. Обычно держим
`@premium_test_bot` для dev и `@premium_omsk_bot` для prod.

## 6.6. Деплой-чеклист

1. `git push origin main` → Vercel деплоит.
2. (если изменилась схема) GitHub Actions `supabase-migrate.yml` накатывает
   миграции.
3. Если новый бот / новый домен:
   ```bash
   PUBLIC_URL="https://your-app.vercel.app" \
   TELEGRAM_BOT_TOKEN="..." \
   TELEGRAM_WEBHOOK_SECRET="..." \
   bash scripts/set-telegram-webhook.sh

   PUBLIC_URL="https://your-app.vercel.app" \
   MAX_BOT_TOKEN="..." \
   bash scripts/set-max-webhook.sh
   ```
4. Проверка `GET /api/admin/health` → должен вернуть `{ ok: true }`.
5. В Telegram написать боту `/start` → ответил, увидели запись в
   `webhook_inbox` и `messages`.
