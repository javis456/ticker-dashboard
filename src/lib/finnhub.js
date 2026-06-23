// Multi-provider quote/news/profile/candle client.
//
// Routing:
//   US tickers      → Finnhub directly (browser → finnhub.io, has CORS support)
//   Non-US tickers  → /api/global-quote proxy (server → Yahoo Finance)
//
// Same exported functions and shapes as before, so existing callers don't change.

import { parseTicker, getMarket } from './markets';

const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_KEY;
const AV_KEY      = import.meta.env.VITE_ALPHAVANTAGE_KEY;
const FH_BASE     = 'https://finnhub.io/api/v1';

if (!FINNHUB_KEY) console.warn('VITE_FINNHUB_KEY is missing.');
if (!AV_KEY)      console.warn('VITE_ALPHAVANTAGE_KEY is missing — US price chart will not work.');

// ---- In-memory cache to limit API usage ----
const cache = new Map();
const CACHE_TTL = {
  quote:   60 * 1000,
  profile: 24 * 3600 * 1000,
  news:    5  * 60 * 1000,
  candle:  60 * 60 * 1000,
};

async function cached(key, ttl, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fetcher();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`HTTP ${res.status} for ${url}:`, body);
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

// Fetch from the global proxy (server-side Yahoo). Returns { quote, candles, errors }.
async function fetchGlobal(symbol, kind, months) {
  const params = new URLSearchParams({ symbol, kind });
  if (months) params.set('months', String(months));
  return fetchJson(`/api/global-quote?${params.toString()}`);
}

// ---- Quote: returns Finnhub-shape { c, d, dp, h, l, o, pc, t } ----
export async function getQuote(symbol) {
  return cached(`quote:${symbol}`, CACHE_TTL.quote, async () => {
    const parsed = parseTicker(symbol);
    if (!parsed) throw new Error(`Invalid ticker: ${symbol}`);

    if (parsed.market === 'US') {
      const q = await fetchJson(`${FH_BASE}/quote?symbol=${parsed.code}&token=${FINNHUB_KEY}`);
      if (!q || (q.c === 0 && q.pc === 0))
        console.warn(`No quote data for ${symbol} — may be invalid or unsupported`);
      return q;
    }

    // Non-US → proxy
    const data = await fetchGlobal(symbol, 'quote');
    return data.quote || { c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 };
  });
}

// ---- Profile: { name, ticker, exchange, finnhubIndustry, logo, weburl, ... } ----
export async function getProfile(symbol) {
  return cached(`profile:${symbol}`, CACHE_TTL.profile, async () => {
    const parsed = parseTicker(symbol);
    if (!parsed) return {};

    if (parsed.market === 'US') {
      return fetchJson(`${FH_BASE}/stock/profile2?symbol=${parsed.code}&token=${FINNHUB_KEY}`);
    }

    // Non-US: Yahoo proxy doesn't fetch full company profiles (kept lean to avoid
    // extra Yahoo calls). We return a minimal profile from the market registry.
    const market = getMarket(symbol);
    return {
      name:            symbol,
      ticker:          symbol,
      exchange:        market?.exchange || '',
      finnhubIndustry: '',
      weburl:          '',
      logo:            '',
    };
  });
}

// ---- News: [{ id, datetime, headline, source, summary, url, image, category }] ----
// For non-US tickers, we still try Finnhub with the suffixed format (e.g. 0700.HK).
// Finnhub free-tier news coverage outside US is spotty — we accept empty results.
export async function getNews(symbol, daysBack = 7) {
  const to   = new Date();
  const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const fmt  = d => d.toISOString().slice(0, 10);

  return cached(`news:${symbol}:${daysBack}`, CACHE_TTL.news, async () => {
    const parsed = parseTicker(symbol);
    if (!parsed) return [];

    if (parsed.market === 'US') {
      try {
        const data = await fetchJson(
          `${FH_BASE}/company-news?symbol=${parsed.code}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_KEY}`
        );
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    }

    // Non-US: try Finnhub with suffixed format. Many international tickers
    // return empty on free tier; we accept that gracefully. Summarize/Catchup
    // with web-search-enabled models fill the gap for these.
    const SUFFIX = {
      HK: '.HK', JP: '.T',  KR: '.KS', SH: '.SS', SZ: '.SZ',
      TW: '.TW', IN: '.NS', LSE: '.L', DE: '.DE',
    };
    const suffix = SUFFIX[parsed.market] || '';
    try {
      const data = await fetchJson(
        `${FH_BASE}/company-news?symbol=${parsed.code}${suffix}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_KEY}`
      );
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  });
}

// ---- Daily candles for the chart ----
export async function getCandles(symbol, months = 6) {
  return cached(`candle:${symbol}:${months}`, CACHE_TTL.candle, async () => {
    const parsed = parseTicker(symbol);
    if (!parsed) return [];

    const cutoff = Date.now() - months * 30 * 24 * 3600 * 1000;

    if (parsed.market === 'US') {
      if (!AV_KEY) return [];
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY`
        + `&symbol=${parsed.code}&outputsize=compact&apikey=${AV_KEY}`;
      let data;
      try { data = await fetchJson(url); } catch { return []; }
      if (data?.Note)        { console.warn(`AV rate limit:`, data.Note);   return []; }
      if (data?.Information) { console.warn(`AV info:`, data.Information); return []; }
      const series = data?.['Time Series (Daily)'];
      if (!series) return [];
      return Object.entries(series)
        .map(([dateStr, v]) => ({
          date:   new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          ts:     new Date(dateStr).getTime(),
          close:  parseFloat(v['4. close']),
          open:   parseFloat(v['1. open']),
          high:   parseFloat(v['2. high']),
          low:    parseFloat(v['3. low']),
          volume: parseInt(v['5. volume'], 10),
        }))
        .filter(r => r.ts >= cutoff)
        .sort((a, b) => a.ts - b.ts);
    }

    // Non-US → proxy (Yahoo). Already returns { ts, date, open, high, low, close, volume }.
    try {
      const data = await fetchGlobal(symbol, 'candles', months);
      const candles = data.candles || [];
      return candles.filter(r => r.ts >= cutoff).sort((a, b) => a.ts - b.ts);
    } catch { return []; }
  });
}

// ---- Impact classifier (unchanged) ----
const HIGH_KEYWORDS = [
  'beats estimates', 'misses estimates', 'beats expectations', 'misses expectations',
  'cuts guidance', 'raises guidance', 'lowers guidance', 'slashes guidance',
  'profit warning', 'earnings warning',
  'acquires', 'acquisition', 'merger', 'spinoff', 'spin-off',
  'bankruptcy', 'chapter 11', 'going private',
  'ceo steps down', 'ceo resigns', 'ceo fired', 'cfo resigns', 'cfo steps down',
  'sec charges', 'sec investigation', 'doj investigation', 'lawsuit', 'recall',
  'fda approval', 'fda rejects', 'fda denies',
  'data breach', 'hacked', 'cyberattack',
  'wins contract', 'awarded contract',
];

const MED_KEYWORDS = [
  'upgrades', 'downgrades', 'price target', 'analyst', 'initiates coverage',
  'partnership', 'launches', 'unveils', 'expands',
  'beats', 'misses',
];

export function classifyImpact(headline) {
  const h = (headline || '').toLowerCase();
  if (HIGH_KEYWORDS.some(k => h.includes(k))) return 'high';
  if (MED_KEYWORDS.some(k => h.includes(k))) return 'med';
  return 'low';
}

export function timeAgo(unixSeconds) {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 3600)  return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
