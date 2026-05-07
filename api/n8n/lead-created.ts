// Тонкий прокси из n8n обратно к Telegram-боту, если n8n надо что-то
// быстро отправить пользователю или владельцу — но напрямую в Telegram API
// он этого делать не должен по соображениям ротации токена.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendMessage } from '../../lib/telegram';
import { sendMaxMessage } from '../../lib/max';
import { verifyN8nInbound } from '../../lib/verify';
import { logToDb } from '../../lib/supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!verifyN8nInbound(req.headers['x-premium-secret'] as string | undefined)) {
    return res.status(401).send('Unauthorized');
  }

  const { channel, chatId, userId, text, buttons } = req.body as {
    channel: 'telegram' | 'max';
    chatId?: string | number;
    userId?: string | number;
    text: string;
    buttons?: unknown;
  };

  try {
    if (channel === 'telegram' && chatId) {
      await sendMessage(chatId, text, { reply_markup: buttons });
    } else if (channel === 'max' && (userId || chatId)) {
      await sendMaxMessage({
        userId: userId ? Number(userId) : undefined,
        chatId: chatId ? Number(chatId) : undefined,
        text,
        buttons: buttons as never,
      });
    } else {
      return res.status(400).send('Bad request');
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logToDb('error', 'vercel:n8n-proxy', msg, { channel });
    res.status(500).json({ ok: false, error: msg });
  }
}
