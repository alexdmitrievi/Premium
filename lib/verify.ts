import { env } from './env';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Telegram setWebhook?secret_token=<X> → header X-Telegram-Bot-Api-Secret-Token: <X>
export function verifyTelegramSecret(headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const expected = Buffer.from(env.TELEGRAM_WEBHOOK_SECRET);
  const got = Buffer.from(headerValue);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

// Простая HMAC-проверка для MAX (если используем proxy с HMAC).
export function verifyHmac(secret: string, payload: string, signatureHex: string | undefined): boolean {
  if (!signatureHex) return false;
  const h = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(h);
  const b = Buffer.from(signatureHex);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyN8nInbound(headerValue: string | undefined): boolean {
  if (!env.N8N_INBOUND_SECRET) return true; // если не задан — пропускаем
  return headerValue === env.N8N_INBOUND_SECRET;
}
