import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabaseAdmin } from '../../lib/supabase';
import { env } from '../../lib/env';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const { error } = await supabaseAdmin().from('services').select('id').limit(1);
    if (error) throw error;
    res.status(200).json({
      ok: true,
      env: env.PROJECT_ENV,
      timezone: env.DEFAULT_TIMEZONE,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
