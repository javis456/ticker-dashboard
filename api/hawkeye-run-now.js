// Vercel serverless function: POST /api/hawkeye-run-now
//
// Body: { identity: "..." }
// Runs the same logic as hawkeye-daily but scoped to ONE user's enabled cards.
// Useful for: user clicks "Run check now" in the UI to verify/refresh data
//             without waiting for the 5 PM ET cron.
//
// Safety: only appends today's candle if the Finnhub quote is actually from
// today's NYC trading session (skips weekends, holidays).

import { createClient } from '@supabase/supabase-js';

const FINNHUB_KEY  = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getFinnhubQuote(symbol) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  return r.json();
}

function todayEasternMidnightMs() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getTime();
}

function easternDateString(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function evaluateCondition(condition, candles, currentPrice) {
  const { direction, thresholdPct, triggerWindowDays, reference } = condition;
  if (!candles || candles.length === 0 || !currentPrice) return null;
  const triggerFrom = Date.now() - triggerWindowDays * 86400000;
  const inTrigger = candles.filter(c => c.ts >= triggerFrom);
  if (inTrigger.length === 0) return null;
  let refPrice, refTs;
  if (reference === 'lowest') {
    const w = inTrigger.reduce((m, c) => (c.low  < m.low  ? c : m), inTrigger[0]);
    refPrice = w.low;  refTs = w.ts;
  } else if (reference === 'highest') {
    const w = inTrigger.reduce((m, c) => (c.high > m.high ? c : m), inTrigger[0]);
    refPrice = w.high; refTs = w.ts;
  } else if (reference === 'first') {
    refPrice = inTrigger[0].open; refTs = inTrigger[0].ts;
  } else { return null; }
  const pctChange = ((currentPrice - refPrice) / refPrice) * 100;
  const triggered = (direction === 'gain' && pctChange >=  thresholdPct)
                 || (direction === 'loss' && pctChange <= -thresholdPct);
  return { triggered, refPrice, refDate: new Date(refTs).toISOString().slice(0, 10), currentPrice, pctChange };
}

function conditionKey(c) {
  return [c.direction, c.thresholdPct, c.triggerWindowDays, c.reference].join('|');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!FINNHUB_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'env vars missing' });
  }

  const { identity } = req.body || {};
  if (!identity) return res.status(400).json({ error: 'identity required' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const summary = { updated: 0, fired: 0, errors: [], skipped_quote_not_today: 0 };

  // Fetch this user's enabled cards
  const { data: cards, error: cErr } = await supabase
    .from('hawkeye_cards').select('*')
    .eq('identity', identity).eq('enabled', true);
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!cards || cards.length === 0) {
    return res.status(200).json({ ok: true, cards: 0, ...summary });
  }

  const uniqueTickers = [...new Set(cards.flatMap(c => c.tickers || []))];

  const { data: histRows } = await supabase
    .from('hawkeye_history').select('*').in('ticker', uniqueTickers);
  const historyByTicker = {};
  (histRows || []).forEach(r => { historyByTicker[r.ticker] = r; });

  const todayMs = todayEasternMidnightMs();
  const todayDateStr = easternDateString(Date.now());
  const quotes = {};

  for (const tk of uniqueTickers) {
    try {
      const q = await getFinnhubQuote(tk);
      if (!q || !q.c) continue;
      quotes[tk] = q.c;

      const histRow = historyByTicker[tk];
      if (!histRow || !histRow.bootstrapped) continue;

      // Only append if quote is from today's NYC trading session
      const quoteTs = (q.t || 0) * 1000;
      if (quoteTs > 0) {
        const quoteDateStr = easternDateString(quoteTs);
        if (quoteDateStr !== todayDateStr) {
          summary.skipped_quote_not_today++;
          continue;
        }
      }

      const candles = histRow.candles || [];
      const existingIdx = candles.findIndex(c => c.ts === todayMs);
      const newCandle = {
        ts: todayMs,
        open: q.o ?? q.c,
        high: q.h ?? q.c,
        low:  q.l ?? q.c,
        close: q.c,
      };
      if (existingIdx >= 0) candles[existingIdx] = newCandle;
      else candles.push(newCandle);

      historyByTicker[tk].candles = candles;
      historyByTicker[tk].last_close_ts = todayMs;

      await supabase.from('hawkeye_history').upsert({
        ticker: tk, candles, bootstrapped: true,
        last_close_ts: todayMs, last_updated: new Date().toISOString(),
      });
      summary.updated++;
    } catch (e) {
      summary.errors.push(`${tk}: ${e.message}`);
    }
    await sleep(150);
  }

  // Re-evaluate conditions
  for (const card of cards) {
    const tickers = card.tickers || [];
    const conditions = card.conditions || [];
    const existingHits = card.hits || [];
    const firedSet = new Set(existingHits.map(h => `${h.ticker}|${h.conditionKey}`));
    const newHits = [];

    for (const ticker of tickers) {
      const hist = historyByTicker[ticker];
      if (!hist?.bootstrapped || !hist.candles?.length) continue;
      const px = quotes[ticker];
      if (!px) continue;
      for (const condition of conditions) {
        const ck = conditionKey(condition);
        if (firedSet.has(`${ticker}|${ck}`)) continue;
        const result = evaluateCondition(condition, hist.candles, px);
        if (!result?.triggered) continue;
        newHits.push({
          id: 'hit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          ticker, conditionKey: ck, condition: { ...condition },
          refPrice: result.refPrice, refDate: result.refDate,
          firedPrice: result.currentPrice,
          pctChange: Number(result.pctChange.toFixed(2)),
          firedAt: new Date().toISOString(),
          isRead: false,
        });
        firedSet.add(`${ticker}|${ck}`);
      }
    }

    if (newHits.length > 0) {
      const merged = [...newHits, ...existingHits];
      await supabase.from('hawkeye_cards').update({
        hits: merged, last_checked: new Date().toISOString(),
      }).eq('id', card.id);
      summary.fired += newHits.length;
    } else {
      await supabase.from('hawkeye_cards').update({
        last_checked: new Date().toISOString(),
      }).eq('id', card.id);
    }
  }

  return res.status(200).json({
    ok: true, cards: cards.length, tickers: uniqueTickers.length, ...summary,
  });
}
