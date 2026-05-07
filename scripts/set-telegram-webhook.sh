#!/usr/bin/env bash
# Регистрируем вебхук Telegram. Запуск:
#   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PUBLIC_URL=https://your-app.vercel.app \
#       bash scripts/set-telegram-webhook.sh
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_WEBHOOK_SECRET:?TELEGRAM_WEBHOOK_SECRET is required}"
: "${PUBLIC_URL:?PUBLIC_URL (https://...) is required}"

URL="${PUBLIC_URL%/}/api/telegram/webhook"

echo "Registering Telegram webhook → $URL"
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "url": "${URL}",
  "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ["message", "edited_message", "callback_query"],
  "drop_pending_updates": true
}
JSON
)"
echo
echo "Done. Verify:"
echo "  curl -sS https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo | jq"
