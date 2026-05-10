// Безопасное чтение env с типами и явным fail-fast.
// Все переменные читаются ТОЛЬКО на сервере (Vercel Functions).

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  // Supabase
  SUPABASE_URL: req('SUPABASE_URL'),
  SUPABASE_ANON_KEY: req('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: req('SUPABASE_SERVICE_ROLE_KEY'),

  // Telegram
  TELEGRAM_BOT_TOKEN: req('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_WEBHOOK_SECRET: req('TELEGRAM_WEBHOOK_SECRET'),
  TELEGRAM_OWNER_CHAT_ID: opt('TELEGRAM_OWNER_CHAT_ID'),
  // username бота (без @) — нужен для генерации deep-link реферала t.me/<bot>?start=ref_XXX
  TELEGRAM_BOT_USERNAME: opt('TELEGRAM_BOT_USERNAME', 'premium_omsk_bot'),
  // username бота в MAX (для реферальной ссылки max.ru/<bot>?start=ref_XXX)
  MAX_BOT_USERNAME: opt('MAX_BOT_USERNAME', 'premium_omsk_bot'),
  // Отображаемое имя бренда в текстах (используется в приветствии и т.п.)
  BOT_BRAND_NAME: opt('BOT_BRAND_NAME', 'Подряд PRO'),

  // MAX
  MAX_BOT_TOKEN: opt('MAX_BOT_TOKEN'),
  MAX_API_URL: opt('MAX_API_URL', 'https://botapi.max.ru'),
  MAX_WEBHOOK_SECRET: opt('MAX_WEBHOOK_SECRET'),

  // n8n
  N8N_WEBHOOK_URL: opt('N8N_WEBHOOK_URL'),
  N8N_TELEGRAM_WEBHOOK_URL: opt('N8N_TELEGRAM_WEBHOOK_URL'),
  N8N_MAX_WEBHOOK_URL: opt('N8N_MAX_WEBHOOK_URL'),
  N8N_INBOUND_SECRET: opt('N8N_INBOUND_SECRET'),

  // Прочее
  PROJECT_ENV: opt('PROJECT_ENV', 'development'),
  LOG_LEVEL: opt('LOG_LEVEL', 'info'),
  DEFAULT_TIMEZONE: opt('DEFAULT_TIMEZONE', 'Asia/Omsk'),
  DEFAULT_CITY: opt('DEFAULT_CITY', 'Омск'),
};

export type Env = typeof env;
