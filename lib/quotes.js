// Server-side universal quote/candle fetching.
//
// US tickers      → Finnhub (quote) + Alpha Vantage (history), unchanged.
// Non-US tickers  → Yahoo Finance v8 chart endpoint (genuinely free, no API key,
//                   covers HK / JP / KR / SH / SZ / TW / IN / LSE / DE).
//
// The Yahoo v8 chart endpoint returns BOTH the latest quote (in meta) and the
// full candle history (in timestamp + indicators.quote) in a single call, which
// is more efficient than a two-call quote+history design.
//
// IMPORTANT: Yahoo's endpoint rejects requests without a browser-like User-Agent,
// and it must be called server-side (browser CORS blocks it). That's why all
// non-US data flows through our own /api/* serverless functions.
//
// All responses are normalized to the Finnhub shape so existing callers are
// unaffected:  quote  → { c, d, dp, h, l, o, pc, t }
//              candle → { ts, open, high, low, close }

import { parseTicker, getMarket, toYahooSymbol, MARKETS } from './markets.js';

const FINNHUB_KEY = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY;

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
};

async function fetchJson(url, label, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
  return r.json();
}

// Fetch the Yahoo v8 chart payload for a non-US symbol.
// range/interval: '1d'/'1m' for a fresh quote, or wider for history.
// Tries query1 then query2 for resilience.
async function fetchYahooChart(yahooSymbol, { range = '6mo', interval = '1d' } = {}) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`
        + `?range=${range}&interval=${interval}&includePrePost=false`;
      const data = await fetchJson(url, `yahoo:${yahooSymbol}`, { headers: YAHOO_HEADERS });
      if (data?.chart?.error) {
        throw new Error(data.chart.error?.description || 'Yahoo chart error');
      }
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error('Yahoo: empty result');
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo: all hosts failed');
}

// Korea has two boards: KOSPI (.KS) and KOSDAQ (.KQ). The market registry maps
// KR → .KS by default, but many smaller / chip-related names trade on KOSDAQ.
// If a Korean .KS lookup fails or returns no price, retry with .KQ.
async function fetchYahooWithKoreaFallback(symbol, opts) {
  const parsed = parseTicker(symbol);
  const ySym = toYahooSymbol(symbol);

  if (!parsed || parsed.market !== 'KR') {
    return fetchYahooChart(ySym, opts);
  }

  // Korean ticker: try .KS first, then .KQ
  try {
    const result = await fetchYahooChart(ySym, opts);
    const hasPrice = result?.meta?.regularMarketPrice != null;
    if (hasPrice) return result;
  } catch (e) { /* fall through to KOSDAQ */ }

  const kqSym = parsed.code + '.KQ';
  return fetchYahooChart(kqSym, opts);
}

// ─── Public: fetch a single normalized quote ──────────────────────────────────
// Returns Finnhub-style quote: { c, d, dp, h, l, o, pc, t }  (t = unix seconds)
export async function fetchQuote(symbol) {
  const parsed = parseTicker(symbol);
  if (!parsed) throw new Error(`Invalid ticker: ${symbol}`);

  if (parsed.market === 'US') {
    if (!FINNHUB_KEY) throw new Error('FINNHUB_KEY not configured');
    return fetchJson(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(parsed.code)}&token=${FINNHUB_KEY}`,
      `finnhub:${symbol}`
    );
  }

  // Non-US → Yahoo. Use a 1-month daily range so we have enough candles to
  // compute the change from the last two ACTUAL trading days (mirrors how
  // Finnhub's d/dp works). A 5d range made chartPreviousClose point several days
  // back rather than to yesterday — that was the % change bug.
  const result = await fetchYahooWithKoreaFallback(symbol, { range: '1mo', interval: '1d' });
  const meta = result.meta || {};

  const close = num(meta.regularMarketPrice);

  // Pull the daily closes from the candle arrays.
  const q = result.indicators?.quote?.[0] || {};
  const closes = Array.isArray(q.close) ? q.close : [];
  // Collect valid (non-null) closes in order.
  const validCloses = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null && !isNaN(closes[i])) validCloses.push({ i, v: num(closes[i]) });
  }

  // "Today" close = live regularMarketPrice if present, else the last valid close.
  // "Prev" close = the valid close on the trading day before today's.
  let todayClose = close;
  let prevClose;
  if (validCloses.length >= 2) {
    const lastCandleClose = validCloses[validCloses.length - 1].v;
    if (todayClose == null) todayClose = lastCandleClose;
    // If the live price equals the last candle (market closed) the previous day
    // is the second-to-last; if live price is a fresh intraday value not yet in
    // the candles, the last candle IS yesterday.
    const lastIsToday = Math.abs((todayClose ?? 0) - lastCandleClose) < 1e-9;
    prevClose = lastIsToday
      ? validCloses[validCloses.length - 2].v
      : validCloses[validCloses.length - 1].v;
  } else {
    // Fallback to meta's previousClose if we somehow lack candles.
    prevClose = num(meta.chartPreviousClose ?? meta.previousClose);
  }

  const lastIdx = lastValidIndex(q.close);
  const dayOpen  = lastIdx >= 0 ? num(q.open?.[lastIdx])  : todayClose;
  const dayHigh  = lastIdx >= 0 ? num(q.high?.[lastIdx])  : todayClose;
  const dayLow   = lastIdx >= 0 ? num(q.low?.[lastIdx])   : todayClose;

  const change = (todayClose != null && prevClose != null) ? todayClose - prevClose : 0;
  const pct    = (todayClose != null && prevClose) ? (change / prevClose) * 100 : 0;
  const t      = meta.regularMarketTime || Math.floor(Date.now() / 1000);

  return {
    c:  todayClose ?? 0,
    d:  change,
    dp: pct,
    h:  dayHigh ?? todayClose ?? 0,
    l:  dayLow  ?? todayClose ?? 0,
    o:  dayOpen ?? todayClose ?? 0,
    pc: prevClose ?? 0,
    t,
    // Extra context Yahoo gives us for free (used for names + metrics):
    name:     meta.longName || meta.shortName || null,
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    fiftyTwoWeekHigh: num(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow:  num(meta.fiftyTwoWeekLow),
    marketCap: num(meta.marketCap),   // often absent in chart meta; may be null
  };
}

// ─── Public: fetch daily candles (oldest → newest) ────────────────────────────
// Returns [{ ts, open, high, low, close }]  (ts = unix ms at UTC midnight of trading day)
export async function fetchDailyCandles(symbol, days = 100) {
  const parsed = parseTicker(symbol);
  if (!parsed) throw new Error(`Invalid ticker: ${symbol}`);

  if (parsed.market === 'US') {
    const AV_KEY = process.env.ALPHAVANTAGE_KEY || process.env.VITE_ALPHAVANTAGE_KEY;
    if (!AV_KEY) throw new Error('ALPHAVANTAGE_KEY not configured');
    const size = days > 100 ? 'full' : 'compact';
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY`
      + `&symbol=${encodeURIComponent(parsed.code)}&outputsize=${size}&apikey=${AV_KEY}`;
    const data = await fetchJson(url, `alphavantage:${symbol}`);
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

  // Non-US → Yahoo chart with an appropriate range.
  const range = days <= 30 ? '1mo'
              : days <= 90 ? '3mo'
              : days <= 180 ? '6mo'
              : days <= 370 ? '1y'
              : '2y';
  const ySym = toYahooSymbol(symbol);
  const result = await fetchYahooWithKoreaFallback(symbol, { range, interval: '1d' });

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = num(q.close?.[i]);
    if (close == null) continue;  // skip holiday/null rows
    // Yahoo timestamps are the session time; snap to UTC midnight of that local date
    const ms = utcMidnightOf(timestamps[i] * 1000, getMarket(symbol)?.timezone);
    candles.push({
      ts:    ms,
      open:  num(q.open?.[i])  ?? close,
      high:  num(q.high?.[i])  ?? close,
      low:   num(q.low?.[i])   ?? close,
      close,
    });
  }
  return candles.sort((a, b) => a.ts - b.ts);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? null : n;
}

function lastValidIndex(arr) {
  if (!Array.isArray(arr)) return -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return i;
  }
  return -1;
}

// Given an epoch-ms instant and a market timezone, return the UTC-midnight ms
// of the local calendar date. Keeps candle keys consistent across the app.
function utcMidnightOf(ms, timezone) {
  if (!timezone) return Math.floor(ms / 86400000) * 86400000;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getTime();
  } catch {
    return Math.floor(ms / 86400000) * 86400000;
  }
}

// "Today" in a given market timezone, as UTC-midnight ms of the local date.
export function todayInMarketMs(marketCode) {
  const tz = MARKETS?.[marketCode]?.timezone;
  return utcMidnightOf(Date.now(), tz);
}

