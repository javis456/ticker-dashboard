// Vercel serverless function: GET /api/global-quote
//
// Browser-side code can't call Yahoo Finance directly (CORS + cookie/crumb).
// This proxy fetches quote + candles server-side and returns a normalized payload.
//
// Query params:
//   symbol   — internal ticker, e.g. "HK:0700" or "AAPL"
//   kind     — "quote" | "candles" | "both"   (default "both")
//   months   — for candles, how many months back (default 6)
//
// Response:
//   { quote: { c,d,dp,h,l,o,pc,t }, candles: [{ ts, date, open, high, low, close, volume }] }
//   (whichever were requested)
//
// Cached at the CDN edge briefly to avoid hammering Yahoo.

import { fetchQuote, fetchDailyCandles } from '../lib/quotes.js';
import { parseTicker, getMarket } from '../lib/markets.js';

export default async function handler(req, res) {
  const { symbol, kind = 'both', months = '6' } = req.query || {};
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const parsed = parseTicker(symbol);
  if (!parsed) return res.status(400).json({ error: `invalid ticker: ${symbol}` });

  // Short edge cache: quotes change minute-to-minute, candles hour-to-hour.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  const out = {};
  const errors = [];

  try {
    if (kind === 'quote' || kind === 'both') {
      try {
        out.quote = await fetchQuote(symbol);
      } catch (e) {
        errors.push(`quote: ${e.message}`);
        out.quote = { c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 };
      }
    }

    if (kind === 'candles' || kind === 'both') {
      try {
        const days = Math.min(Math.max(parseInt(months, 10) || 6, 1) * 31, 760);
        const raw = await fetchDailyCandles(symbol, days);
        // Add a display date string for the chart
        out.candles = raw.map(c => ({
          ...c,
          date: new Date(c.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          volume: c.volume || 0,
        }));
      } catch (e) {
        errors.push(`candles: ${e.message}`);
        out.candles = [];
      }
    }

    if (errors.length > 0) out.errors = errors;
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
