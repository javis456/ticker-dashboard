// Vercel serverless function: POST /api/hawkeye-save-history
//
// Body: { ticker: "AMD", candles: [{ts, open, high, low, close}, ...] }
//
// Saves user-pasted historical data directly to hawkeye_history,
// marking the ticker as bootstrapped. The daily cron then just appends
// today's close each weekday from Finnhub.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });

  const { ticker, candles } = req.body || {};
  if (!ticker || !Array.isArray(candles) || candles.length === 0) {
    return res.status(400).json({ error: 'ticker and candles[] required' });
  }

  const cleaned = candles
    .filter(c => c && typeof c.ts === 'number' && typeof c.close === 'number' && !isNaN(c.close))
    .map(c => ({
      ts:    c.ts,
      open:  typeof c.open  === 'number' && !isNaN(c.open)  ? c.open  : c.close,
      high:  typeof c.high  === 'number' && !isNaN(c.high)  ? c.high  : c.close,
      low:   typeof c.low   === 'number' && !isNaN(c.low)   ? c.low   : c.close,
      close: c.close,
    }))
    .sort((a, b) => a.ts - b.ts);

  if (cleaned.length === 0) {
    return res.status(400).json({ error: 'No valid candles after cleaning' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const lastTs = cleaned[cleaned.length - 1].ts;

  const { error } = await supabase.from('hawkeye_history').upsert({
    ticker: ticker.toUpperCase(),
    candles: cleaned,
    bootstrapped: true,
    last_close_ts: lastTs,
    last_updated: new Date().toISOString(),
    bootstrap_error: null,
  });

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    ok: true,
    ticker: ticker.toUpperCase(),
    count: cleaned.length,
    fromDate: new Date(cleaned[0].ts).toISOString().slice(0, 10),
    toDate:   new Date(lastTs).toISOString().slice(0, 10),
  });
}
