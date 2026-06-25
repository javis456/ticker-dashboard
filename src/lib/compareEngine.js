// compareEngine.js
//
// Pure computation layer for the Compare feature. No AI, no network.
// Given parsed financials for up to 5 stocks, produces ready-to-render
// tables and chart series for each comparison topic.
//
// All heavy lifting is done here so the React components only render.

// ── Currencies ───────────────────────────────────────────────────────────────
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

// ── Formatting helpers ───────────────────────────────────────────────────────
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

// ── Period helpers ───────────────────────────────────────────────────────────
// Quarterly periods come newest-first ("Q3 2026","Q2 2026",...). For charts we
// want oldest→newest, and usually only the last N quarters.

// Parse "Q3 2026" → sortable integer 2026*4 + 3
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

// Annual periods: "Current","FY 2025","FY 2024"... newest-first already.
export function sortedAnnuals(periods, { limit = 6, ascending = true } = {}) {
  // Keep given order but trim; "Current" is newest
  const trimmed = limit ? periods.slice(0, limit) : periods;
  return ascending ? [...trimmed].reverse() : trimmed;
}

// ── Stock accessor ───────────────────────────────────────────────────────────
// A "stock" entry = { id, name, ticker, currency, color, parsed }
// parsed is the output of parseFinancials.

function metricVal(stock, key, period) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return null;
  const v = m.values[period];
  return (v === undefined) ? null : v;
}

// Latest available quarterly value for a metric
function latestQuarter(stock, key) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return { value: null, period: null };
  const periods = sortedQuarters(stock.parsed.periods.quarterly, { limit: 0, ascending: false });
  for (const p of periods) {
    if (m.values[p] != null) return { value: m.values[p], period: p };
  }
  return { value: null, period: null };
}

// Latest available annual value for a metric (Current first)
function latestAnnual(stock, key) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return { value: null, period: null };
  const periods = stock.parsed.periods.annual;
  for (const p of periods) {
    if (m.values[p] != null) return { value: m.values[p], period: p };
  }
  return { value: null, period: null };
}

// Trailing-twelve-month sum of a quarterly flow metric (revenue, FCF, etc.)
function ttm(stock, key) {
  const m = stock.parsed?.metrics?.[key];
  if (!m) return null;
  const quarters = sortedQuarters(stock.parsed.periods.quarterly, { limit: 4, ascending: false });
  let sum = 0, count = 0;
  for (const p of quarters) {
    if (m.values[p] != null) { sum += m.values[p]; count++; }
  }
  return count === 4 ? sum : (count > 0 ? sum * (4 / count) : null);
}

// ── TOPIC DEFINITIONS ────────────────────────────────────────────────────────
// Each topic produces { charts: [...], tables: [...] } when run via buildTopic().
// Topics declare which metrics they need; buildTopic assembles series/rows.

export const TOPICS = [
  { id: 'revenue',   label: 'Revenue',        icon: 'TrendingUp',   desc: 'Revenue & net profit over time' },
  { id: 'margin',    label: 'Margins',        icon: 'Percent',      desc: 'Gross, operating, net & EBITDA margins' },
  { id: 'returns',   label: 'Returns',        icon: 'Target',       desc: 'ROE, ROA, ROIC & turnover' },
  { id: 'growth',    label: 'Growth',         icon: 'LineChart',    desc: 'Revenue, EPS & FCF growth rates' },
  { id: 'fcf',       label: 'Free Cash',      icon: 'Banknote',     desc: 'Free cash flow, margin & conversion' },
  { id: 'debt',      label: 'Debt',           icon: 'Scale',        desc: 'Leverage, liquidity & coverage' },
  { id: 'dilution',  label: 'Dilution',       icon: 'Users',        desc: 'Share count & buybacks over time' },
  { id: 'investing', label: 'Investing',      icon: 'Hammer',       desc: 'Capex intensity vs revenue & cash' },
  { id: 'working',   label: 'Working Capital',icon: 'RefreshCw',    desc: 'Receivables, inventory & collection' },
  { id: 'valuation', label: 'Valuation',      icon: 'Tag',          desc: 'P/E, P/S, P/B, EV multiples' },
];

// Build everything a topic needs to render, across all selected stocks.
// Returns { charts: [{type,title,unit,series|categories,...}], tables: [{title, columns, rows}] }
export function buildTopic(topicId, stocks) {
  switch (topicId) {
    case 'revenue':   return buildRevenue(stocks);
    case 'margin':    return buildMargin(stocks);
    case 'returns':   return buildReturns(stocks);
    case 'growth':    return buildGrowth(stocks);
    case 'fcf':       return buildFcf(stocks);
    case 'debt':      return buildDebt(stocks);
    case 'dilution':  return buildDilution(stocks);
    case 'investing': return buildInvesting(stocks);
    case 'working':   return buildWorking(stocks);
    case 'valuation': return buildValuation(stocks);
    default:          return { charts: [], tables: [] };
  }
}

// Helper: build a time-series chart across stocks for a quarterly metric.
// Returns rows shaped for Recharts: [{ period, [ticker1]: v, [ticker2]: v }]
function quarterlySeries(stocks, key, { limit = 12 } = {}) {
  // Union of quarters across stocks, sorted asc
  const allQ = new Set();
  stocks.forEach(s => (s.parsed?.periods?.quarterly || []).forEach(p => allQ.add(p)));
  const periods = sortedQuarters([...allQ], { limit, ascending: true });
  return periods.map(period => {
    const row = { period };
    stocks.forEach(s => { row[s.ticker] = metricVal(s, key, period); });
    return row;
  });
}

function annualSeries(stocks, key, { limit = 6 } = {}) {
  const allY = [];
  const seen = new Set();
  stocks.forEach(s => (s.parsed?.periods?.annual || []).forEach(p => { if (!seen.has(p)) { seen.add(p); allY.push(p); } }));
  const periods = sortedAnnuals(allY, { limit, ascending: true });
  return periods.map(period => {
    const row = { period };
    stocks.forEach(s => { row[s.ticker] = metricVal(s, key, period); });
    return row;
  });
}

// ── Topic builders ───────────────────────────────────────────────────────────

function buildRevenue(stocks) {
  const revSeries = quarterlySeries(stocks, 'revenue', { limit: 12 });
  const niSeries  = quarterlySeries(stocks, 'netIncome', { limit: 12 });

  const rows = stocks.map(s => {
    const rev = latestQuarter(s, 'revenue');
    const revTTM = ttm(s, 'revenue');
    const ni = latestQuarter(s, 'netIncome');
    const niTTM = ttm(s, 'netIncome');
    const g = latestQuarter(s, 'revenueGrowthYoY');
    return {
      ticker: s.ticker, currency: s.currency,
      cells: {
        latestRev: { v: rev.value, fmt: 'money' },
        ttmRev:    { v: revTTM,    fmt: 'money' },
        latestNI:  { v: ni.value,  fmt: 'money' },
        ttmNI:     { v: niTTM,     fmt: 'money' },
        revGrowth: { v: g.value,   fmt: 'percent' },
      },
    };
  });

  return {
    charts: [
      { type: 'bar-grouped', title: 'Quarterly Revenue', unit: 'money', dataKey: 'revenue', rows: revSeries, note: 'Values in each stock\u2019s own currency' },
      { type: 'bar-grouped', title: 'Quarterly Net Income', unit: 'money', dataKey: 'netIncome', rows: niSeries },
    ],
    tables: [
      { title: 'Revenue & Profit Snapshot', columns: [
          { key: 'latestRev', label: 'Latest Qtr Revenue' },
          { key: 'ttmRev',    label: 'TTM Revenue' },
          { key: 'latestNI',  label: 'Latest Qtr Net Income' },
          { key: 'ttmNI',     label: 'TTM Net Income' },
          { key: 'revGrowth', label: 'Revenue Growth (YoY)', higherBetter: true },
        ], rows },
    ],
  };
}

function buildMargin(stocks) {
  const gm = quarterlySeries(stocks, 'grossMargin', { limit: 12 });
  const nm = quarterlySeries(stocks, 'profitMargin', { limit: 12 });

  const rows = stocks.map(s => ({
    ticker: s.ticker, currency: s.currency,
    cells: {
      gross:  { v: latestQuarter(s, 'grossMargin').value,     fmt: 'percent' },
      oper:   { v: latestQuarter(s, 'operatingMargin').value, fmt: 'percent' },
      net:    { v: latestQuarter(s, 'profitMargin').value,    fmt: 'percent' },
      ebitda: { v: latestQuarter(s, 'ebitdaMargin').value,    fmt: 'percent' },
      fcf:    { v: latestQuarter(s, 'fcfMargin').value,       fmt: 'percent' },
    },
  }));

  return {
    charts: [
      { type: 'line', title: 'Gross Margin Trend', unit: 'percent', rows: gm },
      { type: 'line', title: 'Net Margin Trend',   unit: 'percent', rows: nm },
    ],
    tables: [
      { title: 'Margin Comparison (latest quarter)', columns: [
          { key: 'gross',  label: 'Gross Margin',     higherBetter: true },
          { key: 'oper',   label: 'Operating Margin', higherBetter: true },
          { key: 'net',    label: 'Net Margin',       higherBetter: true },
          { key: 'ebitda', label: 'EBITDA Margin',    higherBetter: true },
          { key: 'fcf',    label: 'FCF Margin',       higherBetter: true },
        ], rows },
    ],
  };
}

function buildReturns(stocks) {
  const roeSeries = annualSeries(stocks, 'roe', { limit: 6 });
  const rows = stocks.map(s => ({
    ticker: s.ticker, currency: s.currency,
    cells: {
      roe:  { v: latestAnnual(s, 'roe').value,  fmt: 'percent' },
      roa:  { v: latestAnnual(s, 'roa').value,  fmt: 'percent' },
      roic: { v: latestAnnual(s, 'roic').value, fmt: 'percent' },
      asset:{ v: latestAnnual(s, 'assetTurnover').value, fmt: 'ratiox' },
      inv:  { v: latestAnnual(s, 'inventoryTurnover').value, fmt: 'ratiox' },
    },
  }));
  return {
    charts: [
      { type: 'bar-grouped', title: 'Return on Equity (annual)', unit: 'percent', rows: roeSeries },
    ],
    tables: [
      { title: 'Capital Efficiency', columns: [
          { key: 'roe',  label: 'Return on Equity',  higherBetter: true },
          { key: 'roa',  label: 'Return on Assets',  higherBetter: true },
          { key: 'roic', label: 'Return on Invested Capital', higherBetter: true },
          { key: 'asset',label: 'Asset Turnover',    higherBetter: true },
          { key: 'inv',  label: 'Inventory Turnover',higherBetter: true },
        ], rows },
    ],
  };
}

function buildGrowth(stocks) {
  const revG = quarterlySeries(stocks, 'revenueGrowthYoY', { limit: 12 });
  const rows = stocks.map(s => ({
    ticker: s.ticker, currency: s.currency,
    cells: {
      rev: { v: latestQuarter(s, 'revenueGrowthYoY').value, fmt: 'percent' },
      ni:  { v: latestQuarter(s, 'netIncomeGrowth').value,  fmt: 'percent' },
      eps: { v: latestQuarter(s, 'epsGrowth').value,        fmt: 'percent' },
    },
  }));
  return {
    charts: [
      { type: 'line', title: 'Revenue Growth (YoY) Trend', unit: 'percent', rows: revG },
    ],
    tables: [
      { title: 'Growth Rates (latest quarter, YoY)', columns: [
          { key: 'rev', label: 'Revenue Growth', higherBetter: true },
          { key: 'ni',  label: 'Net Income Growth', higherBetter: true },
          { key: 'eps', label: 'EPS Growth', higherBetter: true },
        ], rows },
    ],
  };
}

function buildFcf(stocks) {
  const fcfSeries = quarterlySeries(stocks, 'freeCashFlow', { limit: 12 });
  const rows = stocks.map(s => {
    const ocf = latestQuarter(s, 'operatingCashFlow').value;
    const capex = latestQuarter(s, 'capex').value;
    return {
      ticker: s.ticker, currency: s.currency,
      cells: {
        fcf:    { v: latestQuarter(s, 'freeCashFlow').value, fmt: 'money' },
        fcfTTM: { v: ttm(s, 'freeCashFlow'), fmt: 'money' },
        margin: { v: latestQuarter(s, 'fcfMargin').value, fmt: 'percent' },
        ocf:    { v: ocf, fmt: 'money' },
        capex:  { v: capex, fmt: 'money' },
      },
    };
  });
  return {
    charts: [
      { type: 'bar-grouped', title: 'Free Cash Flow (quarterly)', unit: 'money', rows: fcfSeries },
    ],
    tables: [
      { title: 'Cash Generation', columns: [
          { key: 'fcf',    label: 'Free Cash Flow (Qtr)', higherBetter: true },
          { key: 'fcfTTM', label: 'Free Cash Flow (TTM)', higherBetter: true },
          { key: 'margin', label: 'FCF Margin', higherBetter: true },
          { key: 'ocf',    label: 'Operating Cash Flow', higherBetter: true },
          { key: 'capex',  label: 'Capital Expenditure' },
        ], rows },
    ],
  };
}

function buildDebt(stocks) {
  const rows = stocks.map(s => ({
    ticker: s.ticker, currency: s.currency,
    cells: {
      std:     { v: latestQuarter(s, 'shortTermDebt').value, fmt: 'money' },
      ltd:     { v: latestQuarter(s, 'longTermDebt').value,  fmt: 'money' },
      total:   { v: latestQuarter(s, 'totalDebt').value,     fmt: 'money' },
      netcash: { v: latestQuarter(s, 'netCashDebt').value,   fmt: 'money', higherBetter: true },
      current: { v: latestAnnual(s, 'currentRatio').value,   fmt: 'ratio', higherBetter: true },
      quick:   { v: latestAnnual(s, 'quickRatio').value,     fmt: 'ratio', higherBetter: true },
      de:      { v: latestAnnual(s, 'debtEquity').value,     fmt: 'ratio', higherBetter: false },
      debtEbitda:{ v: latestAnnual(s, 'debtEbitda').value,   fmt: 'ratiox', higherBetter: false },
    },
  }));
  // Debt composition stacked bar (latest quarter)
  const compRows = stocks.map(s => ({
    ticker: s.ticker,
    shortTermDebt: latestQuarter(s, 'shortTermDebt').value || 0,
    longTermDebt:  latestQuarter(s, 'longTermDebt').value || 0,
  }));
  return {
    charts: [
      { type: 'bar-stacked', title: 'Debt Composition (latest quarter)', unit: 'money',
        keys: ['shortTermDebt', 'longTermDebt'], rows: compRows, perStockCurrency: true },
    ],
    tables: [
      { title: 'Leverage & Liquidity', columns: [
          { key: 'std',       label: 'Short-Term Debt' },
          { key: 'ltd',       label: 'Long-Term Debt' },
          { key: 'total',     label: 'Total Debt' },
          { key: 'netcash',   label: 'Net Cash (Debt)', higherBetter: true },
          { key: 'current',   label: 'Current Ratio',   higherBetter: true },
          { key: 'quick',     label: 'Quick Ratio',     higherBetter: true },
          { key: 'de',        label: 'Debt / Equity',   higherBetter: false },
          { key: 'debtEbitda',label: 'Debt / EBITDA',   higherBetter: false },
        ], rows },
    ],
  };
}

function buildDilution(stocks) {
  const sharesSeries = quarterlySeries(stocks, 'sharesDiluted', { limit: 12 });
  const rows = stocks.map(s => {
    const shares = sortedQuarters(s.parsed?.periods?.quarterly || [], { limit: 0, ascending: true });
    const m = s.parsed?.metrics?.sharesDiluted;
    let first = null, last = null;
    if (m) {
      for (const p of shares) { if (m.values[p] != null) { first = m.values[p]; break; } }
      for (let i = shares.length - 1; i >= 0; i--) { if (m.values[shares[i]] != null) { last = m.values[shares[i]]; break; } }
    }
    const totalChange = (first && last) ? (last - first) / first : null;
    return {
      ticker: s.ticker, currency: s.currency,
      cells: {
        current: { v: latestQuarter(s, 'sharesDiluted').value, fmt: 'number' },
        change:  { v: latestQuarter(s, 'sharesChangeYoY').value, fmt: 'percent', higherBetter: false },
        total:   { v: totalChange, fmt: 'percent', higherBetter: false },
        buyback: { v: latestAnnual(s, 'buybackYield').value, fmt: 'percent', higherBetter: true },
      },
    };
  });
  return {
    charts: [
      { type: 'line', title: 'Diluted Shares Outstanding', unit: 'number', rows: sharesSeries, note: 'Falling line = buybacks (good); rising = dilution' },
    ],
    tables: [
      { title: 'Share Count & Dilution', columns: [
          { key: 'current', label: 'Diluted Shares (latest)' },
          { key: 'change',  label: 'Shares Change (YoY)', higherBetter: false },
          { key: 'total',   label: 'Total Change (period)', higherBetter: false },
          { key: 'buyback', label: 'Buyback Yield', higherBetter: true },
        ], rows },
    ],
  };
}

function buildInvesting(stocks) {
  const rows = stocks.map(s => {
    const capex = Math.abs(latestQuarter(s, 'capex').value || 0) || null;
    const rev   = latestQuarter(s, 'revenue').value;
    const ocf   = latestQuarter(s, 'operatingCashFlow').value;
    const capexToRev = (capex && rev) ? capex / rev : null;
    const capexToOcf = (capex && ocf) ? capex / ocf : null;
    return {
      ticker: s.ticker, currency: s.currency,
      cells: {
        capex:      { v: latestQuarter(s, 'capex').value, fmt: 'money' },
        capexToRev: { v: capexToRev, fmt: 'percent' },
        capexToOcf: { v: capexToOcf, fmt: 'percent' },
        rev:        { v: rev, fmt: 'money' },
      },
    };
  });
  // capex intensity bar (capex/revenue) — single value per stock
  const intensityRows = stocks.map(s => {
    const capex = Math.abs(latestQuarter(s, 'capex').value || 0);
    const rev = latestQuarter(s, 'revenue').value;
    return { ticker: s.ticker, value: (capex && rev) ? capex / rev : null };
  });
  return {
    charts: [
      { type: 'bar-single', title: 'Capex Intensity (Capex ÷ Revenue)', unit: 'percent', rows: intensityRows },
    ],
    tables: [
      { title: 'Investment in the Business', columns: [
          { key: 'capex',      label: 'Capex (latest qtr)' },
          { key: 'rev',        label: 'Revenue (latest qtr)' },
          { key: 'capexToRev', label: 'Capex / Revenue' },
          { key: 'capexToOcf', label: 'Capex / Operating Cash Flow' },
        ], rows },
    ],
  };
}

function buildWorking(stocks) {
  // DSO ≈ (Accounts Receivable / quarterly revenue) * ~91 days
  const arSeries = quarterlySeries(stocks, 'accountsReceivable', { limit: 12 });
  const rows = stocks.map(s => {
    const ar  = latestQuarter(s, 'accountsReceivable').value;
    const rev = latestQuarter(s, 'revenue').value;
    const inv = latestQuarter(s, 'inventory').value;
    const dso = (ar && rev) ? (ar / rev) * 91.25 : null;
    const invTurn = latestAnnual(s, 'inventoryTurnover').value;
    return {
      ticker: s.ticker, currency: s.currency,
      cells: {
        ar:   { v: ar, fmt: 'money' },
        inv:  { v: inv, fmt: 'money' },
        dso:  { v: dso, fmt: 'days', higherBetter: false },
        invTurn: { v: invTurn, fmt: 'ratiox', higherBetter: true },
      },
    };
  });
  return {
    charts: [
      { type: 'bar-grouped', title: 'Accounts Receivable (quarterly)', unit: 'money', rows: arSeries,
        note: 'Rising receivables faster than revenue can mean customers are paying slower' },
    ],
    tables: [
      { title: 'Collection & Inventory', columns: [
          { key: 'ar',      label: 'Accounts Receivable' },
          { key: 'inv',     label: 'Inventory' },
          { key: 'dso',     label: 'Days Sales Outstanding (est.)', higherBetter: false },
          { key: 'invTurn', label: 'Inventory Turnover', higherBetter: true },
        ], rows },
    ],
  };
}

function buildValuation(stocks) {
  const rows = stocks.map(s => ({
    ticker: s.ticker, currency: s.currency,
    cells: {
      pe:      { v: latestAnnual(s, 'peRatio').value,   fmt: 'ratiox', higherBetter: false },
      fpe:     { v: latestAnnual(s, 'forwardPE').value, fmt: 'ratiox', higherBetter: false },
      ps:      { v: latestAnnual(s, 'psRatio').value,   fmt: 'ratiox', higherBetter: false },
      pb:      { v: latestAnnual(s, 'pbRatio').value,   fmt: 'ratiox', higherBetter: false },
      evEbitda:{ v: latestAnnual(s, 'evEbitda').value,  fmt: 'ratiox', higherBetter: false },
      peg:     { v: latestAnnual(s, 'pegRatio').value,  fmt: 'ratio',  higherBetter: false },
    },
  }));
  // PE comparison bar
  const peRows = stocks.map(s => ({ ticker: s.ticker, value: latestAnnual(s, 'peRatio').value }));
  return {
    charts: [
      { type: 'bar-single', title: 'P/E Ratio', unit: 'ratiox', rows: peRows },
    ],
    tables: [
      { title: 'Valuation Multiples', columns: [
          { key: 'pe',       label: 'P/E',         higherBetter: false },
          { key: 'fpe',      label: 'Forward P/E', higherBetter: false },
          { key: 'ps',       label: 'P/S',         higherBetter: false },
          { key: 'pb',       label: 'P/B',         higherBetter: false },
          { key: 'evEbitda', label: 'EV/EBITDA',   higherBetter: false },
          { key: 'peg',      label: 'PEG',         higherBetter: false },
        ], rows },
    ],
  };
}

// ── Cell formatting dispatcher (used by the table renderer) ──────────────────
export function formatCell(cell, currency) {
  if (!cell || cell.v == null || isNaN(cell.v)) return '—';
  switch (cell.fmt) {
    case 'money':   return fmtMoney(cell.v, currency);
    case 'percent': return fmtPercent(cell.v);
    case 'ratio':   return fmtRatio(cell.v, 2);
    case 'ratiox':  return fmtRatio(cell.v, 1, 'x');
    case 'number':  return fmtNumber(cell.v);
    case 'days':    return `${Math.round(cell.v)}d`;
    default:        return String(cell.v);
  }
}
