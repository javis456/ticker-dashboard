// Market registry and ticker symbol parsing.
// Used by both client and server code.
//
// Ticker symbol format:
//   US (default): "AAPL", "NVDA"
//   Non-US:       "HK:0700"   → Hong Kong Tencent
//                 "JP:7203"   → Tokyo Toyota
//                 "KR:005930" → Korea Samsung
//                 "SH:600519" → Shanghai Moutai
//                 "SZ:000858" → Shenzhen Wuliangye
//                 "TW:2330"   → Taiwan TSMC
//                 "IN:RELIANCE" → India Reliance
//                 "LSE:BARC"  → London Barclays
//                 "DE:SAP"    → Frankfurt SAP

export const MARKETS = {
  US:  { code: 'US',  name: 'United States', currency: 'USD', currencySymbol: '$',   exchange: 'XNAS', timezone: 'America/New_York', provider: 'finnhub',    yahooSuffix: ''    },
  HK:  { code: 'HK',  name: 'Hong Kong',     currency: 'HKD', currencySymbol: 'HK$', exchange: 'HKEX', timezone: 'Asia/Hong_Kong',   provider: 'yahoo',      yahooSuffix: '.HK' },
  JP:  { code: 'JP',  name: 'Japan (Tokyo)', currency: 'JPY', currencySymbol: '¥',   exchange: 'TSE',  timezone: 'Asia/Tokyo',       provider: 'yahoo',      yahooSuffix: '.T'  },
  KR:  { code: 'KR',  name: 'Korea',         currency: 'KRW', currencySymbol: '₩',   exchange: 'KRX',  timezone: 'Asia/Seoul',       provider: 'yahoo',      yahooSuffix: '.KS' },
  SH:  { code: 'SH',  name: 'Shanghai',      currency: 'CNY', currencySymbol: '¥',   exchange: 'SSE',  timezone: 'Asia/Shanghai',    provider: 'yahoo',      yahooSuffix: '.SS' },
  SZ:  { code: 'SZ',  name: 'Shenzhen',      currency: 'CNY', currencySymbol: '¥',   exchange: 'SZSE', timezone: 'Asia/Shanghai',    provider: 'yahoo',      yahooSuffix: '.SZ' },
  TW:  { code: 'TW',  name: 'Taiwan',        currency: 'TWD', currencySymbol: 'NT$', exchange: 'TWSE', timezone: 'Asia/Taipei',      provider: 'yahoo',      yahooSuffix: '.TW' },
  IN:  { code: 'IN',  name: 'India (NSE)',   currency: 'INR', currencySymbol: '₹',   exchange: 'NSE',  timezone: 'Asia/Kolkata',     provider: 'yahoo',      yahooSuffix: '.NS' },
  LSE: { code: 'LSE', name: 'London',        currency: 'GBP', currencySymbol: '£',   exchange: 'LSE',  timezone: 'Europe/London',    provider: 'yahoo',      yahooSuffix: '.L'  },
  DE:  { code: 'DE',  name: 'Germany',       currency: 'EUR', currencySymbol: '€',   exchange: 'XETR', timezone: 'Europe/Berlin',    provider: 'yahoo',      yahooSuffix: '.DE' },
};

// Convert an internal ticker (e.g. "HK:0700" or "AAPL") to its Yahoo Finance symbol.
//   "AAPL"     -> "AAPL"
//   "HK:0700"  -> "0700.HK"
//   "JP:7203"  -> "7203.T"
//   "KR:005930"-> "005930.KS"
export function toYahooSymbol(symbol) {
  const parsed = parseTicker(symbol);
  if (!parsed) return null;
  const market = MARKETS[parsed.market];
  if (!market) return null;
  return parsed.code + (market.yahooSuffix || '');
}

// Visual badge colors per market (for UI chips)
export const MARKET_BADGE_STYLES = {
  US:  { bg: '#f0f0ec', fg: '#525252' },
  HK:  { bg: '#fee2e2', fg: '#991b1b' },
  JP:  { bg: '#fef3c7', fg: '#a16207' },
  KR:  { bg: '#dcfce7', fg: '#166534' },
  SH:  { bg: '#fce7f3', fg: '#be185d' },
  SZ:  { bg: '#fce7f3', fg: '#9d174d' },
  TW:  { bg: '#dbeafe', fg: '#1e40af' },
  IN:  { bg: '#ffedd5', fg: '#9a3412' },
  LSE: { bg: '#e0e7ff', fg: '#3730a3' },
  DE:  { bg: '#f1f5f9', fg: '#475569' },
};

// Parse a ticker string into { market, code }.
// Returns null for invalid input. Unknown market prefix returns null
// (so callers can prompt the user to fix it).
export function parseTicker(symbol) {
  if (!symbol || typeof symbol !== 'string') return null;
  const trimmed = symbol.trim().toUpperCase();
  if (!trimmed) return null;

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    // No prefix → US ticker
    if (!/^[A-Z0-9.\-]{1,10}$/.test(trimmed)) return null;
    return { market: 'US', code: trimmed };
  }

  const market = trimmed.slice(0, colonIdx);
  let code = trimmed.slice(colonIdx + 1);

  if (!MARKETS[market]) return null;
  // Strip a trailing exchange suffix that users sometimes paste (e.g. "0700.HK")
  const dotIdx = code.indexOf('.');
  if (dotIdx !== -1) code = code.slice(0, dotIdx);
  if (!/^[A-Z0-9.\-]{1,15}$/.test(code)) return null;

  return { market, code };
}

// Format back to display form.
// { market: 'US', code: 'AAPL' } → 'AAPL'
// { market: 'HK', code: '0700' } → 'HK:0700'
export function formatTicker(parsed) {
  if (!parsed) return '';
  if (parsed.market === 'US') return parsed.code;
  return `${parsed.market}:${parsed.code}`;
}

// Normalize an arbitrary user-input ticker string.
// Returns the canonical form, or null if not parseable.
export function normalizeTicker(symbol) {
  const parsed = parseTicker(symbol);
  return parsed ? formatTicker(parsed) : null;
}

// Get the market metadata for a ticker symbol.
export function getMarket(symbol) {
  const parsed = parseTicker(symbol);
  return parsed ? MARKETS[parsed.market] : null;
}

export function isUSTicker(symbol) {
  const parsed = parseTicker(symbol);
  return !parsed || parsed.market === 'US';
}

// Currency-aware price formatting. Used wherever a price needs displaying.
export function formatPrice(symbol, price) {
  if (price === null || price === undefined || isNaN(price)) return '—';
  const market = getMarket(symbol);
  const sym = market?.currencySymbol || '$';
  // JPY and KRW typically shown without decimals
  const noDecimal = market?.currency === 'JPY' || market?.currency === 'KRW';
  if (noDecimal) return `${sym}${Math.round(price).toLocaleString()}`;
  return `${sym}${price.toFixed(2)}`;
}

// Just the ticker code without the market prefix (for displaying the code-only part)
export function tickerCode(symbol) {
  const parsed = parseTicker(symbol);
  return parsed ? parsed.code : symbol;
}

// Just the market code (e.g., 'HK', 'US')
export function tickerMarket(symbol) {
  const parsed = parseTicker(symbol);
  return parsed ? parsed.market : 'US';
}

// Returns a list of placeholder examples shown in input fields
export const TICKER_INPUT_PLACEHOLDER = 'AAPL or HK:0700, JP:7203';

// Help text shown next to ticker inputs
export const TICKER_INPUT_HELP = 'US tickers as-is (AAPL). Non-US prefixed by market: HK, JP, KR, SH, SZ, TW, IN, LSE, DE.';
