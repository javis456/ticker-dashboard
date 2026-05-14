// Finnhub API client. Free tier: 60 calls/minute.
// Sign up at https://finnhub.io to get your key (no credit card required).

const API_KEY = import.meta.env.VITE_FINNHUB_KEY;
const BASE = 'https://finnhub.io/api/v1';

// Alpha Vantage is used only for historical candle data (chart).
// Finnhub's free tier does not include /stock/candle.
// Sign up at https://www.alphavantage.co/support/#api-key (free, no card).
const AV_KEY = import.meta.env.VITE_ALPHAVANTAGE_KEY;

if (!API_KEY) console.warn('VITE_FINNHUB_KEY is missing.');
if (!AV_KEY)  console.warn('VITE_ALPHAVANTAGE_KEY is missing — price chart will not work.');

// ---- Simple in-memory cache to avoid blowing through rate limits ----
const cache = new Map();
const CACHE_TTL = {
  quote:   60 * 1000,
  profile: 24 * 3600 * 1000,
  news:    5  * 60 * 1000,
  candle:  60 * 60 * 1000,   // 1 hour — historical data changes once a day
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

// ---- Finnhub helpers ----
function fh(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${BASE}${path}${sep}token=${API_KEY}`;
}

// Current quote: { c: current, d: change, dp: %, h: high, l: low, o: open, pc: prev close }
export async function getQuote(symbol) {
  return cached(`quote:${symbol}`, CACHE_TTL.quote, async () => {
    const q = await fetchJson(fh(`/quote?symbol=${symbol}`));
    if (!q || (q.c === 0 && q.pc === 0))
      console.warn(`No quote data for ${symbol} — may be invalid or unsupported`);
    return q;
  });
}

// Company profile: { name, ticker, exchange, finnhubIndustry, logo, weburl, ... }
export async function getProfile(symbol) {
  return cached(`profile:${symbol}`, CACHE_TTL.profile, () =>
    fetchJson(fh(`/stock/profile2?symbol=${symbol}`))
  );
}

// Company news: [{ id, datetime, headline, source, summary, url, image, category }]
export async function getNews(symbol, daysBack = 7) {
  const to   = new Date();
  const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const fmt  = d => d.toISOString().slice(0, 10);
  return cached(`news:${symbol}:${daysBack}`, CACHE_TTL.news, () =>
    fetchJson(fh(`/company-news?symbol=${symbol}&from=${fmt(from)}&to=${fmt(to)}`))
  );
}

// ---- Alpha Vantage: daily candle data for the price chart ----
// Alpha Vantage free tier: 25 requests/day.
// outputsize=compact → last 100 trading days (~5 months). Perfect for a 6M chart.
// outputsize=full    → full history (20+ years) but a much larger payload.
// We use compact and slice to the requested month range.
export async function getCandles(symbol, months = 6) {
  return cached(`candle:${symbol}:${months}`, CACHE_TTL.candle, async () => {
    if (!AV_KEY) return [];

    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY`
      + `&symbol=${symbol}&outputsize=compact&apikey=${AV_KEY}`;

    let data;
    try {
      data = await fetchJson(url);
    } catch {
      return [];
    }

    // Alpha Vantage returns an error message object when the symbol isn't found
    // or when the rate limit is hit.
    if (data?.Note) {
      console.warn(`Alpha Vantage rate limit hit for ${symbol}:`, data.Note);
      return [];
    }
    if (data?.Information) {
      console.warn(`Alpha Vantage info for ${symbol}:`, data.Information);
      return [];
    }

    const series = data?.['Time Series (Daily)'];
    if (!series) {
      console.warn(`No Alpha Vantage daily series for ${symbol}`, data);
      return [];
    }

    // Convert to array, sort oldest → newest, then slice to requested month span
    const cutoff = Date.now() - months * 30 * 24 * 3600 * 1000;
    const rows = Object.entries(series)
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

    return rows;
  });
}

// ---- Impact classifier ----
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

