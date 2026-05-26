// Vercel serverless function: GET /api/hawkeye-daily
//
// Called ONCE per weekday by cron-job.org at 5:00 PM ET (after market close).
//
// What it does:
//   1. Bootstrap up to 5 pending tickers from Alpha Vantage (handles new adds gradually)
//   2. For every ticker referenced by an enabled card:
//      - Fetch today's quote from Finnhub
//      - Append today's candle to hawkeye_history (idempotent — won't double-add)
//   3. For each enabled card × ticker × condition:
//      - Run the math against stored history
//      - Record any new hits (dedupe so we don't re-fire the same condition)
//
// API budget per run (80 tickers, fully bootstrapped):
//   - Finnhub: 80 calls (well under 60/min if we batch with small delays)
//   - Alpha Vantage: 0–5 calls (only for new ticker bootstraps)
//   - Total runtime: < 30 seconds (Vercel Hobby limit is 60s)

import { createClient } from '@supabase/supabase-js';

const FINNHUB_KEY      = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY;
const ALPHAVANTAGE_KEY = process.env.ALPHAVANTAGE_KEY || process.env.VITE_ALPHAVANTAGE_KEY;
const SUPABASE_URL     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET      = process.env.CRON_SECRET;

const BOOTSTRAPS_PER_RUN = 5;   // Alpha Vantage allows 5/min, 25/day. We do 5 per daily run.

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
  return r.json();
}

// Finnhub current quote (used to capture today's close after market hours)
async function getFinnhubQuote(symbol) {
  return fetchJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
    'finnhub'
  );
}

// Alpha Vantage full daily series (used only for bootstrap)
async function getAlphaVantageFull(symbol) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY`
    + `&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${ALPHAVANTAGE_KEY}`;
  const data = await fetchJson(url, 'alphavantage');

  if (data?.Note || data?.Information) {
    throw new Error(data.Note || data.Information || 'AV rate limit / info notice');
  }
  const series = data?.['Time Series (Daily)'];
  if (!series) throw new Error('No Time Series (Daily) in AV response');

  return Object.entries(series).map(([dateStr, v]) => ({
    ts:    new Date(dateStr + 'T00:00:00Z').getTime(),
    open:  parseFloat(v['1. open']),
    high:  parseFloat(v['2. high']),
    low:   parseFloat(v['3. low']),
    close: parseFloat(v['4. close']),
  })).sort((a, b) => a.ts - b.ts);
}

// Date for "today's candle" — midnight UTC of today's date in US Eastern
function todayEasternMidnightMs() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getTime();
}

// ─── Math: evaluate ONE condition against history + today's price ─────────────
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
  } else {
    return null;
  }

  const pctChange = ((currentPrice - refPrice) / refPrice) * 100;
  let triggered = false;
  if (direction === 'gain' && pctChange >=  thresholdPct) triggered = true;
  if (direction === 'loss' && pctChange <= -thresholdPct) triggered = true;

  return {
    triggered,
    refPrice, refDate: new Date(refTs).toISOString().slice(0, 10),
    currentPrice, pctChange,
  };
}

function conditionKey(c) {
  return [c.direction, c.thresholdPct, c.triggerWindowDays, c.reference].join('|');
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars missing' });
  if (!FINNHUB_KEY)      return res.status(500).json({ error: 'FINNHUB_KEY missing' });
  if (!ALPHAVANTAGE_KEY) return res.status(500).json({ error: 'ALPHAVANTAGE_KEY missing' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const summary = { bootstrapped: 0, updated: 0, fired: 0, errors: [] };

  // ─── Step 1: Bootstrap a handful of pending tickers ────────────────────────
  const { data: pending } = await supabase
    .from('hawkeye_history')
    .select('ticker')
    .eq('bootstrapped', false)
    .limit(BOOTSTRAPS_PER_RUN);

  if (pending && pending.length > 0) {
    for (let i = 0; i < pending.length; i++) {
      const tk = pending[i].ticker;
      try {
        const candles = await getAlphaVantageFull(tk);
        const lastTs = candles[candles.length - 1]?.ts || null;
        await supabase.from('hawkeye_history').upsert({
          ticker: tk,
          candles,
          bootstrapped: true,
          last_close_ts: lastTs,
          last_updated: new Date().toISOString(),
          bootstrap_error: null,
        });
        summary.bootstrapped++;
      } catch (e) {
        await supabase.from('hawkeye_history').upsert({
          ticker: tk,
          bootstrap_error: String(e.message || e).slice(0, 200),
          last_updated: new Date().toISOString(),
        });
        summary.errors.push(`bootstrap ${tk}: ${e.message}`);
      }
      // Respect AV's 5/min limit
      if (i < pending.length - 1) await sleep(13_000);
    }
  }

  // ─── Step 2: Pull enabled cards & their tickers ────────────────────────────
  const { data: cards, error: cErr } = await supabase
    .from('hawkeye_cards')
    .select('*')
    .eq('enabled', true);
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!cards || cards.length === 0) {
    return res.status(200).json({ ...summary, skipped: 'no enabled cards' });
  }

  const uniqueTickers = [...new Set(cards.flatMap(c => c.tickers || []))];

  // ─── Step 3: Load history for those tickers ────────────────────────────────
  const { data: histRows } = await supabase
    .from('hawkeye_history')
    .select('*')
    .in('ticker', uniqueTickers);
  const historyByTicker = {};
  (histRows || []).forEach(r => { historyByTicker[r.ticker] = r; });

  // ─── Step 4: Fetch today's quote for each ticker, append to history ───────
  // We do this sequentially with small delays to be polite, but Finnhub's
  // 60/min limit gives us 1/sec capacity which is plenty.
  const todayMs = todayEasternMidnightMs();
  const quotes = {};

  for (const tk of uniqueTickers) {
    try {
      const q = await getFinnhubQuote(tk);
      if (!q || !q.c) continue;
      quotes[tk] = q.c;

      const histRow = historyByTicker[tk];
      if (!histRow || !histRow.bootstrapped) {
        // Not bootstrapped yet — skip the append, condition check below will
        // also skip naturally because candles[] is empty
        continue;
      }

      const candles = histRow.candles || [];
      const lastTs = candles[candles.length - 1]?.ts || 0;

      // Append today's candle only if we don't already have it
      if (lastTs < todayMs) {
        const newCandle = {
          ts:    todayMs,
          open:  q.o ?? q.c,
          high:  q.h ?? q.c,
          low:   q.l ?? q.c,
          close: q.c,
        };
        candles.push(newCandle);
        historyByTicker[tk].candles = candles;
        historyByTicker[tk].last_close_ts = todayMs;

        await supabase.from('hawkeye_history').upsert({
          ticker: tk,
          candles,
          bootstrapped: true,
          last_close_ts: todayMs,
          last_updated: new Date().toISOString(),
        });
        summary.updated++;
      }
    } catch (e) {
      summary.errors.push(`quote ${tk}: ${e.message}`);
    }
    // Tiny delay to be polite
    await sleep(150);
  }

  // ─── Step 5: Check conditions ──────────────────────────────────────────────
  for (const card of cards) {
    const tickers     = card.tickers   || [];
    const conditions  = card.conditions || [];
    const existingHits = card.hits     || [];
    const firedSet = new Set(existingHits.map(h => `${h.ticker}|${h.conditionKey}`));
    const newHits = [];

    for (const ticker of tickers) {
      const hist = historyByTicker[ticker];
      if (!hist || !hist.bootstrapped || !hist.candles?.length) continue;
      const px = quotes[ticker];
      if (!px) continue;

      for (const condition of conditions) {
        const ck = conditionKey(condition);
        const dedupe = `${ticker}|${ck}`;
        if (firedSet.has(dedupe)) continue;

        const result = evaluateCondition(condition, hist.candles, px);
        if (!result || !result.triggered) continue;

        newHits.push({
          id: 'hit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          ticker, conditionKey: ck,
          condition: { ...condition },
          refPrice:   result.refPrice,
          refDate:    result.refDate,
          firedPrice: result.currentPrice,
          pctChange:  Number(result.pctChange.toFixed(2)),
          firedAt:    new Date().toISOString(),
          isRead:     false,
        });
        firedSet.add(dedupe);
      }
    }

    if (newHits.length > 0) {
      const merged = [...newHits, ...existingHits];
      await supabase.from('hawkeye_cards').update({
        hits: merged,
        last_checked: new Date().toISOString(),
      }).eq('id', card.id);
      summary.fired += newHits.length;
    } else {
      await supabase.from('hawkeye_cards').update({
        last_checked: new Date().toISOString(),
      }).eq('id', card.id);
    }
  }

  return res.status(200).json({
    ok: true,
    cards: cards.length,
    tickers: uniqueTickers.length,
    ...summary,
  });
}
