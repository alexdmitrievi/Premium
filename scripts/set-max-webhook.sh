#!/usr/bin/env bash
# Регистрация вебхука MAX-бота. Финальная схема настройки уточняется
# в актуальной документации MAX (через MasterBot и REST API).
set -euo pipefail

: "${MAX_BOT_TOKEN:?MAX_BOT_TOKEN is required}"
: "${PUBLIC_URL:?PUBLIC_URL (https://...) is required}"
MAX_API_URL="${MAX_API_URL:-https://botapi.max.ru}"

URL="${PUBLIC_URL%/}/api/max/webhook"

echo "Registering MAX webhook → $URL"
curl -sS -X POST "${MAX_API_URL}/subscriptions?access_token=${MAX_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "url": "${URL}",
  "update_types": ["message_created", "message_callback"]
}
JSON
)"
echo
echo "Done."
