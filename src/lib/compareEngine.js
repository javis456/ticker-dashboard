// compareEngine.js (v2)
// Pure computation layer for the Compare feature. No AI, no network.

// Magnitude options the user picks to tell us what abbreviated pasted numbers
// really mean. e.g. if the data was shown "in millions", multiply by 1e6.
export const SCALE_OPTIONS = [
  { factor: 1,    label: 'As-is (raw)',     short: 'Raw' },
  { factor: 1e3,  label: 'Thousands (K)',   short: 'K' },
  { factor: 1e6,  label: 'Millions (M)',    short: 'M' },
  { factor: 1e9,  label: 'Billions (B)',    short: 'B' },
];

export const CURRENCIES = {
  USD: { code: 'USD', symbol: '$',   name: 'US Dollar',      decimals: 2 },
  KRW: { code: 'KRW', symbol: '₩',   name: 'Korean Won',     decimals: 0 },
  CNY: { code: 'CNY', symbol: '¥',   name: 'Chinese Yuan',   decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥',   name: 'Japanese Yen',   decimals: 0 },
  TWD: { code: 'TWD', symbol: 'NT$', name: 'Taiwan Dollar',  decimals: 2 },
  HKD: { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar', decimals: 2 },
  EUR: { code: 'EUR', symbol: '€',   name: 'Euro',           decimals: 2 },
  GBP: { code: 'GBP', symbol: '£',   name: 'British Pound',  decimals: 2 },
};

export function fmtMoney(value, currencyCode, { compact = true } = {}) {
  if (value == null || isNaN(value)) return '—';
  const cur = CURRENCIES[currencyCode] || CURRENCIES.USD;
  const sym = cur.symbol;
  const neg = value < 0;
  let v = Math.abs(value);
  let suffix = '';
  if (compact) {
    if (v >= 1e12) { v = v / 1e12; suffix = 'T'; }
    else if (v >= 1e9)  { v = v / 1e9;  suffix = 'B'; }
    else if (v >= 1e6)  { v = v / 1e6;  suffix = 'M'; }
    else if (v >= 1e3)  { v = v / 1e3;  suffix = 'K'; }
  }
  const decimals = suffix ? 1 : cur.decimals;
  const num = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${neg ? '-' : ''}${sym}${num}${suffix}`;
}
export function fmtPercent(value, decimals = 1) {
  if (value == null || isNaN(value)) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}
export function fmtRatio(value, decimals = 2, suffix = '') {
  if (value == null || isNaN(value)) return '—';
  return `${value.toFixed(decimals)}${suffix}`;
}
export function fmtNumber(value, { compact = true, decimals = 1 } = {}) {
  if (value == null || isNaN(value)) return '—';
  const neg = value < 0;
  let v = Math.abs(value);
  let suffix = '';
  if (compact) {
    if (v >= 1e12) { v = v / 1e12; suffix = 'T'; }
    else if (v >= 1e9)  { v = v / 1e9;  suffix = 'B'; }
    else if (v >= 1e6)  { v = v / 1e6;  suffix = 'M'; }
    else if (v >= 1e3)  { v = v / 1e3;  suffix = 'K'; }
  }
  const d = suffix ? decimals : 0;
  return `${neg ? '-' : ''}${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}${suffix}`;
}

function quarterKey(p) {
  const m = /Q([1-4])\s+(\d{4})/.exec(p);
  if (!m) return 0;
  return parseInt(m[2], 10) * 4 + parseInt(m[1], 10);
}
export function sortedQuarters(periods, { limit = 12, ascending = true } = {}) {
  const sorted = [...periods].sort((a, b) => quarterKey(a) - quarterKey(b));
  const trimmed = limit ? sorted.slice(-limit) : sorted;
  return ascending ? trimmed : [...trimmed].reverse();
}
export function sortedAnnuals(periods, { limit = 6, ascending = true } = {}) {
  const trimmed = limit ? periods.slice(0, limit) : periods;
  return ascending ? [...trimmed].reverse() : trimmed;
}
function latestQuartersAcross(stocks, n) {
  const all = new Set();
  stocks.forEach(s => (s.parsed?.periods?.quarterly || []).forEach(p => all.add(p)));
  return sortedQuarters([...all], { limit: 0, ascending: false }).slice(0, n);
}
function latestAnnualsAcross(stocks, n) {
  const seen = new Set(); const out = [];
  stocks.forEach(s => (s.parsed?.periods?.annual || []).forEach(p => { if (!seen.has(p)) { seen.add(p); out.push(p); } }));
  return out.slice(0, n);
}

const MONEY_KEYS = new Set([
  'revenue','costOfRevenue','grossProfit','operatingIncome','netIncome','netIncomeToCommon',
  'ebitda','ebit','researchDevelopment','sga',
  'cashAndEquivalents','cashAndShortTerm','accountsReceivable','inventory','totalCurrentAssets',
  'netPPE','goodwill','totalAssets','accountsPayable','shortTermDebt','currentPortionLTD',
  'totalCurrentLiab','longTermDebt','totalLiabilities','shareholdersEquity','totalDebt',
  'netCashDebt','workingCapital',
  'operatingCashFlow','capex','investingCashFlow','financingCashFlow','freeCashFlow',
  'stockBasedComp','repurchaseCommonStock','dividendsPaid','changeInReceivables','changeInInventory',
  'marketCap','enterpriseValue',
]);
const PERSHARE_MONEY_KEYS = new Set(['epsBasic','epsDiluted','freeCashFlowPerShare','bookValuePerShare']);
// Share-count keys are abbreviated the same way money is, so the scale multiplier
// applies to them too (needed for correct P/S = price * shares / revenue).
const SHARE_COUNT_KEYS = new Set(['sharesBasic','sharesDiluted']);

function convFactor(stock, usd) {
  if (!usd) return 1;
  const f = stock.fxToUsd;
  return (f && !isNaN(f)) ? f : 1;
}
// The per-stock scale multiplier the user chose (e.g. data pasted "in millions"
// => scaleFactor 1e6). Defaults to 1 (raw). Applied to aggregate money and share
// counts, but NOT to per-share figures (EPS, BVPS) or ratios/percentages, which
// are already in absolute units.
function scaleFactor(stock) {
  const s = stock.scaleFactor;
  return (s && !isNaN(s) && s > 0) ? s : 1;
}
function isScalableMoney(key) {
  return MONEY_KEYS.has(key) || SHARE_COUNT_KEYS.has(key);
}
function rawVal(stock, key, period) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return null;
  const v = m.values[period];
  if (v === undefined) return null;
  // Apply the user-chosen magnitude scale to aggregate money & share counts.
  if (isScalableMoney(key)) return v * scaleFactor(stock);
  return v;
}
function val(stock, key, period, usd) {
  const v = rawVal(stock, key, period);
  if (v == null) return null;
  if (usd && (MONEY_KEYS.has(key) || PERSHARE_MONEY_KEYS.has(key))) return v * convFactor(stock, usd);
  return v;
}
function latestQ(stock, key, usd) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return { value: null, period: null };
  for (const p of sortedQuarters(stock.parsed.periods.quarterly, { limit: 0, ascending: false })) {
    if (m.values[p] != null) return { value: val(stock, key, p, usd), period: p };
  }
  return { value: null, period: null };
}
function latestA(stock, key, usd) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return { value: null, period: null };
  for (const p of stock.parsed.periods.annual) {
    if (m.values[p] != null) return { value: val(stock, key, p, usd), period: p };
  }
  return { value: null, period: null };
}
function ttm(stock, key, usd) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return null;
  const quarters = sortedQuarters(stock.parsed.periods.quarterly, { limit: 4, ascending: false });
  let sum = 0, count = 0;
  for (const p of quarters) { if (m.values[p] != null) { sum += val(stock, key, p, usd); count++; } }
  return count === 4 ? sum : (count > 0 ? sum * (4 / count) : null);
}
function ttmNative(stock, key) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return null;
  const sf = isScalableMoney(key) ? scaleFactor(stock) : 1;
  const quarters = sortedQuarters(stock.parsed.periods.quarterly, { limit: 4, ascending: false });
  let sum = 0, count = 0;
  for (const p of quarters) { if (m.values[p] != null) { sum += m.values[p] * sf; count++; } }
  return count === 4 ? sum : (count > 0 ? sum * (4 / count) : null);
}
function latestQNative(stock, key) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return { value: null };
  const sf = isScalableMoney(key) ? scaleFactor(stock) : 1;
  for (const p of sortedQuarters(stock.parsed.periods.quarterly, { limit: 0, ascending: false })) {
    if (m.values[p] != null) return { value: m.values[p] * sf };
  }
  return { value: null };
}
function liveValuation(stock) {
  const price = stock.livePrice;
  if (!price || isNaN(price)) return { pe: null, ps: null, pb: null, live: false };
  const epsTTM = ttmNative(stock, 'epsDiluted') ?? ttmNative(stock, 'epsBasic');
  const revTTM = ttmNative(stock, 'revenue');
  const sharesQ = latestQNative(stock, 'sharesDiluted').value ?? latestQNative(stock, 'sharesBasic').value;
  const bvps = latestQNative(stock, 'bookValuePerShare').value;
  const pe = (epsTTM && epsTTM > 0) ? price / epsTTM : null;
  const ps = (revTTM && sharesQ) ? (price * sharesQ) / revTTM : null;
  const pb = (bvps && bvps > 0) ? price / bvps : null;
  return { pe, ps, pb, live: true };
}

export const TOPICS = [
  { id: 'revenue',   label: 'Revenue',        icon: 'TrendingUp',   desc: 'Revenue & net profit over time' },
  { id: 'margin',    label: 'Margins',        icon: 'Percent',      desc: 'Gross, operating, net & EBITDA margins' },
  { id: 'returns',   label: 'Returns',        icon: 'Target',       desc: 'ROE, ROA, ROIC & turnover' },
  { id: 'growth',    label: 'Growth',         icon: 'LineChart',    desc: 'Revenue, EPS & profit growth rates' },
  { id: 'rnd',       label: 'R&D',            icon: 'Lightbulb',    desc: 'Research spend & intensity' },
  { id: 'fcf',       label: 'Free Cash',      icon: 'Banknote',     desc: 'Free cash flow, margin & conversion' },
  { id: 'debt',      label: 'Debt',           icon: 'Scale',        desc: 'Leverage, liquidity & coverage' },
  { id: 'dilution',  label: 'Dilution',       icon: 'Users',        desc: 'Share count & buybacks over time' },
  { id: 'investing', label: 'Investing',      icon: 'Hammer',       desc: 'Capex intensity vs revenue & cash' },
  { id: 'working',   label: 'Working Capital',icon: 'RefreshCw',    desc: 'Receivables, inventory & collection' },
  { id: 'valuation', label: 'Valuation',      icon: 'Tag',          desc: 'P/E, P/S, P/B, EV multiples (live price)' },
  { id: 'moneyflow', label: 'Money Flow',     icon: 'GitCompare',   desc: 'Income-statement flow (Sankey) per stock' },
];

export function buildTopic(topicId, stocks, opts = {}) {
  const o = { periods: opts.periods || 1, usd: !!opts.usd };
  switch (topicId) {
    case 'revenue':   return buildRevenue(stocks, o);
    case 'margin':    return buildMargin(stocks, o);
    case 'returns':   return buildReturns(stocks, o);
    case 'growth':    return buildGrowth(stocks, o);
    case 'rnd':       return buildRnd(stocks, o);
    case 'fcf':       return buildFcf(stocks, o);
    case 'debt':      return buildDebt(stocks, o);
    case 'dilution':  return buildDilution(stocks, o);
    case 'investing': return buildInvesting(stocks, o);
    case 'working':   return buildWorking(stocks, o);
    case 'valuation': return buildValuation(stocks, o);
    case 'moneyflow': return buildMoneyFlow(stocks, o);
    default:          return { charts: [], tables: [] };
  }
}

// Apply a per-stock quarter offset: positive shifts the stock's data forward
// (to later periods on the shared axis), negative shifts it back. Used so the
// user can hand-align companies with different fiscal calendars.
function shiftQuarter(period, offset) {
  if (!offset) return period;
  const m = /Q([1-4])\s+(\d{4})/.exec(period);
  if (!m) return period;
  let q = parseInt(m[1], 10);
  let y = parseInt(m[2], 10);
  let idx = y * 4 + (q - 1) + offset;   // zero-based quarter index
  y = Math.floor(idx / 4);
  q = (idx % 4) + 1;
  return `Q${q} ${y}`;
}
function quarterlySeries(stocks, key, { limit = 12, usd = false } = {}) {
  // Build the shared axis from each stock's OFFSET-shifted periods, so a shifted
  // stock lands on the right axis slots.
  const allQ = new Set();
  stocks.forEach(s => {
    const off = s.quarterOffset || 0;
    (s.parsed?.periods?.quarterly || []).forEach(p => allQ.add(shiftQuarter(p, off)));
  });
  const periods = sortedQuarters([...allQ], { limit, ascending: true });
  return periods.map(period => {
    const row = { period };
    stocks.forEach(s => {
      const off = s.quarterOffset || 0;
      // The stock's own period that maps to this axis slot is period - offset.
      const ownPeriod = shiftQuarter(period, -off);
      row[s.ticker] = val(s, key, ownPeriod, usd);
    });
    return row;
  });
}
function annualSeries(stocks, key, { limit = 6, usd = false } = {}) {
  const allY = []; const seen = new Set();
  stocks.forEach(s => (s.parsed?.periods?.annual || []).forEach(p => { if (!seen.has(p)) { seen.add(p); allY.push(p); } }));
  const periods = sortedAnnuals(allY, { limit, ascending: true });
  return periods.map(period => {
    const row = { period };
    stocks.forEach(s => { row[s.ticker] = val(s, key, period, usd); });
    return row;
  });
}

// Each stock shows ITS OWN latest N periods (companies have offset fiscal
// calendars, so a global union would leave blanks). Column slots are labeled
// "latest", "prior", "2 ago" and each stock fills them from its own periods.
function stockLatestQuarters(stock, n) {
  return sortedQuarters(stock.parsed?.periods?.quarterly || [], { limit: 0, ascending: false }).slice(0, n);
}
function stockLatestAnnuals(stock, n) {
  return (stock.parsed?.periods?.annual || []).slice(0, n);
}
const SLOT_LABELS = ['Latest', 'Prior', '2 ago'];

function multiPeriodTable(title, stocks, metricDefs, { periods = 1, usd = false } = {}) {
  const slots = SLOT_LABELS.slice(0, periods);  // e.g. ["Latest"] or ["Latest","Prior","2 ago"]
  const data = {};        // data[ticker][metricLabel][slot] = value
  const periodLabels = {}; // periodLabels[ticker] = { q: ["Q3 2026",...], a: ["Current",...] }

  stocks.forEach(s => {
    const qP = stockLatestQuarters(s, periods);
    const aP = stockLatestAnnuals(s, periods);
    periodLabels[s.ticker] = { q: qP, a: aP };
    data[s.ticker] = {};
    metricDefs.forEach(md => {
      const cells = {};
      const usePeriods = md.scale === 'a' ? aP : qP;
      slots.forEach((slot, i) => {
        const p = usePeriods[i];
        let v = null;
        if (p != null) v = md.derive ? md.derive(s, p, usd) : val(s, md.metricKey, p, usd);
        cells[slot] = v;
      });
      data[s.ticker][md.label] = cells;
    });
  });

  return {
    title, slots,
    periodLabels,  // for showing each stock's actual period under its column
    metrics: metricDefs.map(md => ({ label: md.label, fmt: md.fmt, higherBetter: md.higherBetter, scale: md.scale })),
    data,
  };
}

function buildRevenue(stocks, o) {
  const revSeries = quarterlySeries(stocks, 'revenue', { limit: 12, usd: o.usd });
  const niSeries  = quarterlySeries(stocks, 'netIncome', { limit: 12, usd: o.usd });
  const gpSeries  = quarterlySeries(stocks, 'grossProfit', { limit: 12, usd: o.usd });
  const table = multiPeriodTable('Revenue & Profit', stocks, [
    { label: 'Revenue', metricKey: 'revenue', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'Gross Profit', metricKey: 'grossProfit', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'Operating Income', metricKey: 'operatingIncome', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'Net Income', metricKey: 'netIncome', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'Revenue Growth (YoY)', metricKey: 'revenueGrowthYoY', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'TTM Revenue', scale: 'q', fmt: 'money', higherBetter: true, derive: (s, _p, usd) => ttm(s, 'revenue', usd) },
    { label: 'TTM Net Income', scale: 'q', fmt: 'money', higherBetter: true, derive: (s, _p, usd) => ttm(s, 'netIncome', usd) },
  ], o);
  return {
    charts: [
      { type: 'bar-grouped', title: 'Quarterly Revenue', unit: 'money', rows: revSeries, usd: o.usd },
      { type: 'bar-grouped', title: 'Quarterly Net Income', unit: 'money', rows: niSeries, usd: o.usd },
      { type: 'line', title: 'Gross Profit Trend', unit: 'money', rows: gpSeries, usd: o.usd },
    ],
    tables: [table],
  };
}
function buildMargin(stocks, o) {
  const gm = quarterlySeries(stocks, 'grossMargin', { limit: 12 });
  const nm = quarterlySeries(stocks, 'profitMargin', { limit: 12 });
  const om = quarterlySeries(stocks, 'operatingMargin', { limit: 12 });
  const table = multiPeriodTable('Margins', stocks, [
    { label: 'Gross Margin', metricKey: 'grossMargin', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'Operating Margin', metricKey: 'operatingMargin', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'Net Margin', metricKey: 'profitMargin', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'EBITDA Margin', metricKey: 'ebitdaMargin', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'FCF Margin', metricKey: 'fcfMargin', scale: 'q', fmt: 'percent', higherBetter: true },
  ], o);
  return {
    charts: [
      { type: 'line', title: 'Gross Margin Trend', unit: 'percent', rows: gm },
      { type: 'line', title: 'Operating Margin Trend', unit: 'percent', rows: om },
      { type: 'line', title: 'Net Margin Trend', unit: 'percent', rows: nm },
    ],
    tables: [table],
  };
}
function buildReturns(stocks, o) {
  const roeSeries = annualSeries(stocks, 'roe', { limit: 6 });
  const roicSeries = annualSeries(stocks, 'roic', { limit: 6 });
  const table = multiPeriodTable('Capital Efficiency', stocks, [
    { label: 'Return on Equity', metricKey: 'roe', scale: 'a', fmt: 'percent', higherBetter: true },
    { label: 'Return on Assets', metricKey: 'roa', scale: 'a', fmt: 'percent', higherBetter: true },
    { label: 'Return on Invested Capital', metricKey: 'roic', scale: 'a', fmt: 'percent', higherBetter: true },
    { label: 'Asset Turnover', metricKey: 'assetTurnover', scale: 'a', fmt: 'ratiox', higherBetter: true },
    { label: 'Inventory Turnover', metricKey: 'inventoryTurnover', scale: 'a', fmt: 'ratiox', higherBetter: true },
  ], o);
  return {
    charts: [
      { type: 'bar-grouped', title: 'Return on Equity (annual)', unit: 'percent', rows: roeSeries },
      { type: 'bar-grouped', title: 'Return on Invested Capital (annual)', unit: 'percent', rows: roicSeries },
    ],
    tables: [table],
  };
}
function buildGrowth(stocks, o) {
  const revG = quarterlySeries(stocks, 'revenueGrowthYoY', { limit: 12 });
  const niG = quarterlySeries(stocks, 'netIncomeGrowth', { limit: 12 });
  const table = multiPeriodTable('Growth Rates (YoY)', stocks, [
    { label: 'Revenue Growth', metricKey: 'revenueGrowthYoY', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'Net Income Growth', metricKey: 'netIncomeGrowth', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'EPS Growth', metricKey: 'epsGrowth', scale: 'q', fmt: 'percent', higherBetter: true },
  ], o);
  return {
    charts: [
      { type: 'line', title: 'Revenue Growth (YoY)', unit: 'percent', rows: revG },
      { type: 'line', title: 'Net Income Growth (YoY)', unit: 'percent', rows: niG },
    ],
    tables: [table],
  };
}
function buildRnd(stocks, o) {
  const rndSeries = quarterlySeries(stocks, 'researchDevelopment', { limit: 12, usd: o.usd });
  const allQ = new Set();
  stocks.forEach(s => (s.parsed?.periods?.quarterly || []).forEach(p => allQ.add(p)));
  const iperiods = sortedQuarters([...allQ], { limit: 12, ascending: true });
  const intensitySeries = iperiods.map(period => {
    const row = { period };
    stocks.forEach(s => {
      const rnd = rawVal(s, 'researchDevelopment', period);
      const rev = rawVal(s, 'revenue', period);
      row[s.ticker] = (rnd != null && rev) ? rnd / rev : null;
    });
    return row;
  });
  const table = multiPeriodTable('Research & Development', stocks, [
    { label: 'R&D Expense', metricKey: 'researchDevelopment', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'R&D / Revenue', scale: 'q', fmt: 'percent', higherBetter: true,
      derive: (s, p) => { const rnd = rawVal(s, 'researchDevelopment', p); const rev = rawVal(s, 'revenue', p); return (rnd != null && rev) ? rnd / rev : null; } },
    { label: 'R&D (TTM)', scale: 'q', fmt: 'money', higherBetter: true, derive: (s, _p, usd) => ttm(s, 'researchDevelopment', usd) },
  ], o);
  return {
    charts: [
      { type: 'bar-grouped', title: 'R&D Expense (quarterly)', unit: 'money', rows: rndSeries, usd: o.usd },
      { type: 'line', title: 'R&D Intensity (R&D ÷ Revenue)', unit: 'percent', rows: intensitySeries, note: 'Higher = more reinvested in research' },
    ],
    tables: [table],
  };
}
function buildFcf(stocks, o) {
  const fcfSeries = quarterlySeries(stocks, 'freeCashFlow', { limit: 12, usd: o.usd });
  const ocfSeries = quarterlySeries(stocks, 'operatingCashFlow', { limit: 12, usd: o.usd });
  const table = multiPeriodTable('Cash Generation', stocks, [
    { label: 'Free Cash Flow', metricKey: 'freeCashFlow', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'FCF Margin', metricKey: 'fcfMargin', scale: 'q', fmt: 'percent', higherBetter: true },
    { label: 'Operating Cash Flow', metricKey: 'operatingCashFlow', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'Capex', metricKey: 'capex', scale: 'q', fmt: 'money' },
    { label: 'FCF (TTM)', scale: 'q', fmt: 'money', higherBetter: true, derive: (s, _p, usd) => ttm(s, 'freeCashFlow', usd) },
    { label: 'FCF / Share', metricKey: 'freeCashFlowPerShare', scale: 'q', fmt: 'money2', higherBetter: true },
  ], o);
  return {
    charts: [
      { type: 'bar-grouped', title: 'Free Cash Flow (quarterly)', unit: 'money', rows: fcfSeries, usd: o.usd },
      { type: 'line', title: 'Operating Cash Flow Trend', unit: 'money', rows: ocfSeries, usd: o.usd },
    ],
    tables: [table],
  };
}
function buildDebt(stocks, o) {
  const table = multiPeriodTable('Leverage & Liquidity', stocks, [
    { label: 'Short-Term Debt', metricKey: 'shortTermDebt', scale: 'q', fmt: 'money' },
    { label: 'Long-Term Debt', metricKey: 'longTermDebt', scale: 'q', fmt: 'money' },
    { label: 'Total Debt', metricKey: 'totalDebt', scale: 'q', fmt: 'money' },
    { label: 'Net Cash (Debt)', metricKey: 'netCashDebt', scale: 'q', fmt: 'money', higherBetter: true },
    { label: 'Current Ratio', metricKey: 'currentRatio', scale: 'a', fmt: 'ratio', higherBetter: true },
    { label: 'Quick Ratio', metricKey: 'quickRatio', scale: 'a', fmt: 'ratio', higherBetter: true },
    { label: 'Debt / Equity', metricKey: 'debtEquity', scale: 'a', fmt: 'ratio', higherBetter: false },
    { label: 'Debt / EBITDA', metricKey: 'debtEbitda', scale: 'a', fmt: 'ratiox', higherBetter: false },
  ], o);
  const compRows = stocks.map(s => ({
    ticker: s.ticker,
    shortTermDebt: (latestQ(s, 'shortTermDebt', o.usd).value) || 0,
    longTermDebt: (latestQ(s, 'longTermDebt', o.usd).value) || 0,
  }));
  const liqRows = stocks.map(s => ({
    ticker: s.ticker,
    'Current Ratio': latestA(s, 'currentRatio').value,
    'Quick Ratio': latestA(s, 'quickRatio').value,
  }));
  return {
    charts: [
      { type: 'bar-stacked', title: 'Debt Composition (latest quarter)', unit: 'money', keys: ['shortTermDebt', 'longTermDebt'], rows: compRows, usd: o.usd },
      { type: 'bar-multi', title: 'Liquidity Ratios', unit: 'ratio', keys: ['Current Ratio', 'Quick Ratio'], rows: liqRows },
    ],
    tables: [table],
  };
}
function buildDilution(stocks, o) {
  const sharesSeries = quarterlySeries(stocks, 'sharesDiluted', { limit: 12 });
  const table = multiPeriodTable('Share Count & Dilution', stocks, [
    { label: 'Diluted Shares', metricKey: 'sharesDiluted', scale: 'q', fmt: 'number' },
    { label: 'Shares Change (YoY)', metricKey: 'sharesChangeYoY', scale: 'q', fmt: 'percent', higherBetter: false },
    { label: 'Buyback Yield', metricKey: 'buybackYield', scale: 'a', fmt: 'percent', higherBetter: true },
    { label: 'Stock-Based Comp', metricKey: 'stockBasedComp', scale: 'q', fmt: 'money', higherBetter: false },
  ], o);
  return {
    charts: [
      { type: 'line', title: 'Diluted Shares Outstanding', unit: 'number', rows: sharesSeries, note: 'Falling = buybacks (good); rising = dilution' },
    ],
    tables: [table],
  };
}
function buildInvesting(stocks, o) {
  const capexSeries = quarterlySeries(stocks, 'capex', { limit: 12, usd: o.usd });
  const table = multiPeriodTable('Investment in the Business', stocks, [
    { label: 'Capex', metricKey: 'capex', scale: 'q', fmt: 'money' },
    { label: 'Revenue', metricKey: 'revenue', scale: 'q', fmt: 'money' },
    { label: 'Capex / Revenue', scale: 'q', fmt: 'percent', higherBetter: false,
      derive: (s, p) => { const cx = Math.abs(rawVal(s, 'capex', p) || 0); const rev = rawVal(s, 'revenue', p); return (cx && rev) ? cx / rev : null; } },
    { label: 'Capex / Op. Cash Flow', scale: 'q', fmt: 'percent', higherBetter: false,
      derive: (s, p) => { const cx = Math.abs(rawVal(s, 'capex', p) || 0); const ocf = rawVal(s, 'operatingCashFlow', p); return (cx && ocf) ? cx / ocf : null; } },
  ], o);
  const intensityRows = stocks.map(s => {
    const cx = Math.abs(latestQ(s, 'capex', false).value || 0);
    const rev = latestQ(s, 'revenue', false).value;
    return { ticker: s.ticker, value: (cx && rev) ? cx / rev : null };
  });
  return {
    charts: [
      { type: 'bar-single', title: 'Capex Intensity (Capex ÷ Revenue)', unit: 'percent', rows: intensityRows },
      { type: 'bar-grouped', title: 'Capex (quarterly)', unit: 'money', rows: capexSeries, usd: o.usd },
    ],
    tables: [table],
  };
}
function buildWorking(stocks, o) {
  const arSeries = quarterlySeries(stocks, 'accountsReceivable', { limit: 12, usd: o.usd });
  const invSeries = quarterlySeries(stocks, 'inventory', { limit: 12, usd: o.usd });
  const table = multiPeriodTable('Collection & Inventory', stocks, [
    { label: 'Accounts Receivable', metricKey: 'accountsReceivable', scale: 'q', fmt: 'money' },
    { label: 'Inventory', metricKey: 'inventory', scale: 'q', fmt: 'money' },
    { label: 'Days Sales Outstanding', scale: 'q', fmt: 'days', higherBetter: false,
      derive: (s, p) => { const ar = rawVal(s, 'accountsReceivable', p); const rev = rawVal(s, 'revenue', p); return (ar && rev) ? (ar / rev) * 91.25 : null; } },
    { label: 'Inventory Turnover', metricKey: 'inventoryTurnover', scale: 'a', fmt: 'ratiox', higherBetter: true },
  ], o);
  return {
    charts: [
      { type: 'bar-grouped', title: 'Accounts Receivable (quarterly)', unit: 'money', rows: arSeries, usd: o.usd, note: 'Rising faster than revenue can mean slower customer payments' },
      { type: 'bar-grouped', title: 'Inventory (quarterly)', unit: 'money', rows: invSeries, usd: o.usd },
    ],
    tables: [table],
  };
}
function buildValuation(stocks, o) {
  const liveByTicker = {};
  stocks.forEach(s => { liveByTicker[s.ticker] = liveValuation(s); });
  const table = multiPeriodTable('Valuation Multiples', stocks, [
    { label: 'P/E', scale: 'a', fmt: 'ratiox', higherBetter: false,
      derive: (s) => { const lv = liveByTicker[s.ticker]; return lv.pe != null ? lv.pe : latestA(s, 'peRatio').value; } },
    { label: 'Forward P/E', metricKey: 'forwardPE', scale: 'a', fmt: 'ratiox', higherBetter: false },
    { label: 'P/S', scale: 'a', fmt: 'ratiox', higherBetter: false,
      derive: (s) => { const lv = liveByTicker[s.ticker]; return lv.ps != null ? lv.ps : latestA(s, 'psRatio').value; } },
    { label: 'P/B', scale: 'a', fmt: 'ratiox', higherBetter: false,
      derive: (s) => { const lv = liveByTicker[s.ticker]; return lv.pb != null ? lv.pb : latestA(s, 'pbRatio').value; } },
    { label: 'EV/EBITDA', metricKey: 'evEbitda', scale: 'a', fmt: 'ratiox', higherBetter: false },
    { label: 'PEG', metricKey: 'pegRatio', scale: 'a', fmt: 'ratio', higherBetter: false },
  ], { periods: 1, usd: o.usd });
  const peRows = stocks.map(s => { const lv = liveByTicker[s.ticker]; return { ticker: s.ticker, value: lv.pe != null ? lv.pe : latestA(s, 'peRatio').value }; });
  const psRows = stocks.map(s => { const lv = liveByTicker[s.ticker]; return { ticker: s.ticker, value: lv.ps != null ? lv.ps : latestA(s, 'psRatio').value }; });
  const anyLive = stocks.some(s => liveByTicker[s.ticker].live);
  return {
    charts: [
      { type: 'bar-single', title: 'P/E Ratio' + (anyLive ? ' (live price)' : ''), unit: 'ratiox', rows: peRows },
      { type: 'bar-single', title: 'P/S Ratio' + (anyLive ? ' (live price)' : ''), unit: 'ratiox', rows: psRows },
    ],
    tables: [table],
    liveByTicker,
  };
}

// Money Flow: an income-statement Sankey per stock. Uses trailing-twelve-month
// figures (USD-aware) so the picture is stable and comparable. Each stock yields
// a node/link graph the UI renders as an SVG Sankey.
//
// Flow structure:
//   Revenue ─┬─> Cost of Revenue
//            └─> Gross Profit ─┬─> Operating Expenses ─┬─> R&D
//                              │                       └─> SG&A
//                              └─> Operating Income ─┬─> Tax & Other
//                                                    └─> Net Income
function buildMoneyFlow(stocks, o) {
  const usd = o.usd;
  const flows = stocks.map(s => {
    const cur = usd ? 'USD' : s.currency;
    const revenue  = ttm(s, 'revenue', usd);
    const cor      = ttm(s, 'costOfRevenue', usd);
    let   gross    = ttm(s, 'grossProfit', usd);
    const rnd      = ttm(s, 'researchDevelopment', usd);
    const sga      = ttm(s, 'sga', usd);
    let   opInc    = ttm(s, 'operatingIncome', usd);
    const netInc   = ttm(s, 'netIncome', usd);

    // Derive gross profit if missing but revenue & cost known
    let gp = gross;
    if (gp == null && revenue != null && cor != null) gp = revenue - cor;

    // Build nodes & links defensively — only include flows we have data for.
    const nodes = [];
    const links = [];
    const nodeIndex = {};
    const addNode = (name, kind) => {
      if (nodeIndex[name] != null) return nodeIndex[name];
      const i = nodes.length;
      nodes.push({ name, kind });
      nodeIndex[name] = i;
      return i;
    };
    const addLink = (from, to, value, kind) => {
      if (value == null || isNaN(value) || value <= 0) return;
      links.push({ source: addNode(from, 'mid'), target: addNode(to, kind), value });
    };

    const positive = v => (v != null && v > 0 ? v : null);

    if (revenue != null && revenue > 0) {
      addNode('Revenue', 'root');
      // Revenue splits into cost of revenue + gross profit
      addLink('Revenue', 'Cost of Revenue', positive(cor), 'cost');
      if (gp != null && gp > 0) {
        addLink('Revenue', 'Gross Profit', gp, 'mid');
        // Gross profit splits into OpEx and Operating Income
        const opexParts = [];
        if (positive(rnd)) opexParts.push(['R&D', rnd]);
        if (positive(sga)) opexParts.push(['SG&A', sga]);
        const opexTotal = opexParts.reduce((a, [, v]) => a + v, 0);
        // derive operating income if missing
        let oi = opInc;
        if (oi == null && gp != null) oi = gp - opexTotal;

        if (opexTotal > 0) {
          addLink('Gross Profit', 'Operating Expenses', opexTotal, 'cost');
          opexParts.forEach(([name, v]) => addLink('Operating Expenses', name, v, 'cost'));
        }
        if (oi != null && oi > 0) {
          addLink('Gross Profit', 'Operating Income', oi, 'mid');
          // Operating income splits into net income + tax/other
          if (netInc != null && netInc > 0) {
            addLink('Operating Income', 'Net Income', netInc, 'profit');
            const taxOther = oi - netInc;
            if (taxOther > 0) addLink('Operating Income', 'Tax & Other', taxOther, 'cost');
          }
        }
      }
    }

    const hasData = revenue != null && revenue > 0 && links.length > 0;
    return {
      ticker: s.ticker, color: s.color, currency: cur,
      revenue, hasData,
      sankey: { nodes, links },
    };
  });

  return {
    charts: [{ type: 'sankey-row', title: 'Income Statement Flow (TTM)', unit: 'money', usd, flows }],
    tables: [],
  };
}

export function formatCellValue(v, fmt, currency) {
  if (v == null || isNaN(v)) return '—';
  switch (fmt) {
    case 'money':   return fmtMoney(v, currency);
    case 'money2':  return fmtMoney(v, currency, { compact: false });
    case 'percent': return fmtPercent(v);
    case 'ratio':   return fmtRatio(v, 2);
    case 'ratiox':  return fmtRatio(v, 1, 'x');
    case 'number':  return fmtNumber(v);
    case 'days':    return `${Math.round(v)}d`;
    default:        return String(v);
  }
}
export function formatCell(cell, currency) {
  if (!cell || cell.v == null || isNaN(cell.v)) return '—';
  return formatCellValue(cell.v, cell.fmt, currency);
}
