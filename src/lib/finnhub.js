// Finnhub API client. Free tier: 60 calls/minute.
// Sign up at https://finnhub.io to get your key (no credit card required).

const API_KEY = import.meta.env.VITE_FINNHUB_KEY;
const BASE = 'https://finnhub.io/api/v1';

if (!API_KEY) {
  console.warn('VITE_FINNHUB_KEY is missing. Add it to .env.local or your Vercel env vars.');
}

// ---- Simple in-memory cache to avoid blowing through the rate limit ----
const cache = new Map();
const CACHE_TTL = {
  quote:   60 * 1000,
  profile: 24 * 3600 * 1000,
  news:    5  * 60 * 1000,
  candle:  60 * 60 * 1000,   // 1 hour — historical data doesn't change much
};

async function cached(key, ttl, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fetcher();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}token=${API_KEY}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`Finnhub ${res.status} for ${path}:`, body);
    throw new Error(`Finnhub ${res.status}`);
  }
  return res.json();
}

// Current quote: { c: current, d: change, dp: %, h: high, l: low, o: open, pc: prev close }
export async function getQuote(symbol) {
  return cached(`quote:${symbol}`, CACHE_TTL.quote, async () => {
    const q = await fetchJson(`/quote?symbol=${symbol}`);
    if (!q || (q.c === 0 && q.pc === 0)) {
      console.warn(`No quote data for ${symbol} — may be an invalid or unsupported symbol`);
    }
    return q;
  });
}

// Company profile: { name, ticker, exchange, finnhubIndustry, logo, weburl, ... }
export async function getProfile(symbol) {
  return cached(`profile:${symbol}`, CACHE_TTL.profile, () =>
    fetchJson(`/stock/profile2?symbol=${symbol}`)
  );
}

// Company news. Returns array of { id, datetime, headline, source, summary, url, image, category }
export async function getNews(symbol, daysBack = 7) {
  const to   = new Date();
  const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const fmt  = d => d.toISOString().slice(0, 10);
  return cached(`news:${symbol}:${daysBack}`, CACHE_TTL.news, () =>
    fetchJson(`/company-news?symbol=${symbol}&from=${fmt(from)}&to=${fmt(to)}`)
  );
}

// Daily candle data for charting.
// months: 1, 3, or 6
// Returns array of { date: 'MMM D', close, open, high, low, volume }
// sorted oldest → newest, ready for Recharts.
export async function getCandles(symbol, months = 6) {
  const now  = Math.floor(Date.now() / 1000);
  const from = now - months * 30 * 24 * 3600;

  return cached(`candle:${symbol}:${months}`, CACHE_TTL.candle, async () => {
    const data = await fetchJson(
      `/stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${now}`
    );

    if (!data || data.s !== 'ok' || !Array.isArray(data.t)) {
      console.warn(`No candle data for ${symbol}:`, data?.s);
      return [];
    }

    return data.t.map((ts, i) => ({
      date:   new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ts,
      close:  data.c[i],
      open:   data.o[i],
      high:   data.h[i],
      low:    data.l[i],
      volume: data.v[i],
    }));
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
