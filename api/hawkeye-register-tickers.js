// Vercel serverless function: POST /api/hawkeye-register-tickers
//
// Body: { tickers: ['NVDA', 'AMD', ...] }
//
// Inserts a `bootstrapped: false` row in hawkeye_history for any ticker
// not already there. The daily cron will pick these up over time and fill
// in their full history from Alpha Vantage.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });

  const { tickers } = req.body || {};
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return res.status(400).json({ error: 'tickers[] required' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Find which ones already exist
  const { data: existing } = await supabase
    .from('hawkeye_history')
    .select('ticker, bootstrapped')
    .in('ticker', tickers);

  const existingSet = new Set((existing || []).map(r => r.ticker));
  const toAdd = tickers.filter(t => !existingSet.has(t));

  if (toAdd.length === 0) {
    return res.status(200).json({ added: 0, pending: 0, ready: tickers.length });
  }

  const rows = toAdd.map(t => ({
    ticker: t,
    candles: [],
    bootstrapped: false,
    last_updated: new Date().toISOString(),
  }));

  const { error } = await supabase.from('hawkeye_history').insert(rows);
  if (error) return res.status(500).json({ error: error.message });

  const pendingCount = (existing || []).filter(r => !r.bootstrapped).length + toAdd.length;
  const readyCount   = (existing || []).filter(r => r.bootstrapped).length;

  res.status(200).json({
    added:   toAdd.length,
    pending: pendingCount,
    ready:   readyCount,
  });
}
