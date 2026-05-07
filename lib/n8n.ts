import { env } from './env';

// Тонкий прокси: Vercel-функции отдают «событие» в n8n.
// Это нужно, чтобы тяжёлая логика (нотификации, сторонние API,
// обогащение данных, рассылки) жила в одном месте — в n8n.

export type N8nEvent =
  | { type: 'tg.update'; update: unknown }
  | { type: 'max.update'; update: unknown }
  | { type: 'lead.created'; leadId: string; contactId: string; serviceKind: string; channel: string }
  | { type: 'message.outbound'; channel: string; chatId: string; text: string };

export async function notifyN8n(targetUrl: string, evt: N8nEvent): Promise<void> {
  if (!targetUrl) return;
  const body = JSON.stringify(evt);
  try {
    await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Простой shared secret. n8n валидирует header в Webhook node.
        'x-premium-secret': env.N8N_INBOUND_SECRET,
      },
      body,
      // Vercel-функции — короткие, не ждём долго.
      signal: AbortSignal.timeout(4_000),
    });
  } catch (e) {
    // Логируем, но не валим основной флоу — пользователю уже ответили.
    console.error('notifyN8n failed', e);
  }
}
