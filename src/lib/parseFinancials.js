// parseFinancials.js
//
// Parses pasted financial statement data (from stockanalysis.com-style tables)
// into a normalized, comparison-ready structure. No AI — pure deterministic parsing.
//
// The user copies a stock's financial page which contains up to 4 sections:
//   - Income Statement  (quarterly columns)
//   - Balance Sheet     (quarterly columns)
//   - Cashflow          (quarterly columns)
//   - Key Ratios        (annual columns: Current, FY2025, FY2024, ...)
//
// Each section is a block of tab- or multi-space-separated rows:
//   <Label>\t<val Q1>\t<val Q2>\t...
//
// The parser:
//   1. Splits the paste into sections by recognizing section header lines
//      ("Fiscal Quarter ..." or "Fiscal Year ...") and metric rows
//   2. Reads the period header row (Fiscal Quarter / Fiscal Year) to get column periods
//   3. Maps each metric label to a canonical key via normalization
//   4. Parses values: handles "-" as null, percentages-as-decimals, commas, parentheses
//
// Output:
//   {
//     periods: { quarterly: ["Q3 2026", ...], annual: ["Current","FY 2025", ...] },
//     metrics: {
//       <canonicalKey>: {
//         label, section, scale ('quarterly'|'annual'),
//         values: { "Q3 2026": 41456, ... }   // keyed by period label
//       }
//     },
//     warnings: [...]
//   }

// ── Canonical metric registry ────────────────────────────────────────────────
// Maps normalized label → canonical key. Normalization lowercases, strips
// punctuation and extra spaces, so "Additional Paid-In Capital" and
// "Additional Paid-in Capital" both map to the same key.
//
// We only need to *recognize* the metrics used by the comparison topics, but we
// store everything we can parse so future topics have the data.

function norm(label) {
  let s = String(label || '').toLowerCase();
  // Preserve meaningful parenthetical qualifiers before stripping the rest
  const keepQualifiers = [];
  if (/\bdiluted\b/.test(s)) keepQualifiers.push('diluted');
  else if (/\bbasic\b/.test(s)) keepQualifiers.push('basic');
  s = s
    .replace(/\(.*?\)/g, ' ')       // drop parenthetical qualifiers
    .replace(/[^a-z0-9]+/g, ' ')    // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
  // Re-append qualifier if the base label lost it (e.g. "shares outstanding")
  for (const q of keepQualifiers) {
    if (!s.includes(q)) s = `${s} ${q}`;
  }
  return s;
}

// canonicalKey → list of accepted normalized labels (first is canonical display)
const METRIC_ALIASES = {
  // Income statement
  revenue:              ['revenue'],
  revenueGrowthYoY:     ['revenue growth yoy', 'revenue growth'],
  costOfRevenue:        ['cost of revenue'],
  grossProfit:          ['gross profit'],
  operatingIncome:      ['operating income'],
  netIncome:            ['net income'],
  netIncomeToCommon:    ['net income to common', 'net income to companys stockholders'],
  netIncomeGrowth:      ['net income growth'],
  sharesBasic:          ['shares outstanding basic', 'shares outstanding'],
  sharesDiluted:        ['shares outstanding diluted', 'total common shares outstanding diluted'],
  sharesChangeYoY:      ['shares change yoy', 'shares change'],
  epsBasic:             ['eps basic'],
  epsDiluted:           ['eps diluted'],
  epsGrowth:            ['eps growth'],
  grossMargin:          ['gross margin'],
  operatingMargin:      ['operating margin'],
  profitMargin:         ['profit margin', 'net margin'],
  fcfMargin:            ['fcf margin', 'free cash flow margin'],
  ebitda:               ['ebitda'],
  ebitdaMargin:         ['ebitda margin'],
  ebit:                 ['ebit'],
  ebitMargin:           ['ebit margin'],
  effectiveTaxRate:     ['effective tax rate'],
  researchDevelopment:  ['research development', 'research and development'],
  sga:                  ['selling general administrative', 'selling general and administrative'],

  // Balance sheet
  cashAndEquivalents:   ['cash equivalents', 'cash and equivalents'],
  cashAndShortTerm:     ['cash short term investments', 'cash and short term investments', 'total cash and short term investments'],
  accountsReceivable:   ['accounts receivable', 'receivables'],
  inventory:            ['inventory'],
  totalCurrentAssets:   ['total current assets'],
  netPPE:               ['net property plant equipment', 'net property plant and equipment'],
  goodwill:             ['goodwill'],
  totalAssets:          ['total assets'],
  accountsPayable:      ['accounts payable'],
  shortTermDebt:        ['short term debt'],
  currentPortionLTD:    ['current portion of long term debt'],
  totalCurrentLiab:     ['total current liabilities'],
  longTermDebt:         ['long term debt'],
  totalLiabilities:     ['total liabilities', 'total liabilities and equity'],
  shareholdersEquity:   ['shareholders equity', 'total shareholders equity', 'total common shareholders equity', 'total common equity'],
  totalDebt:            ['total debt'],
  netCashDebt:          ['net cash debt', 'net cash'],
  bookValuePerShare:    ['book value per share'],
  workingCapital:       ['working capital'],

  // Cashflow
  operatingCashFlow:    ['operating cash flow'],
  capex:                ['capital expenditures', 'capital expenditure'],
  investingCashFlow:    ['investing cash flow'],
  financingCashFlow:    ['financing cash flow'],
  freeCashFlow:         ['free cash flow'],
  freeCashFlowPerShare: ['free cash flow per share'],
  stockBasedComp:       ['stock based compensation'],
  repurchaseCommonStock:['repurchase of common stock'],
  dividendsPaid:        ['common dividends paid', 'dividends paid'],
  changeInReceivables:  ['change in receivables', 'change in accounts receivable'],
  changeInInventory:    ['changes in inventories', 'change in inventory'],

  // Key ratios (annual)
  marketCap:            ['market cap', 'market capitalization'],
  enterpriseValue:      ['enterprise value'],
  peRatio:              ['pe ratio'],
  forwardPE:            ['forward pe'],
  pegRatio:             ['peg ratio'],
  psRatio:              ['ps ratio'],
  pbRatio:              ['pb ratio'],
  pFcfRatio:            ['p fcf ratio'],
  pOcfRatio:            ['p ocf ratio'],
  evSales:              ['ev sales ratio'],
  evEbitda:             ['ev ebitda ratio'],
  evEbit:               ['ev ebit ratio'],
  evFcf:                ['ev fcf ratio'],
  debtEquity:           ['debt equity ratio'],
  debtEbitda:           ['debt ebitda ratio'],
  debtFcf:              ['debt fcf ratio'],
  netDebtEbitda:        ['net debt ebitda ratio'],
  assetTurnover:        ['asset turnover'],
  inventoryTurnover:    ['inventory turnover'],
  quickRatio:           ['quick ratio'],
  currentRatio:         ['current ratio'],
  roe:                  ['return on equity', 'return on equity roe'],
  roa:                  ['return on assets', 'return on assets roa'],
  roic:                 ['return on invested capital', 'return on invested capital roic'],
  earningsYield:        ['earnings yield'],
  fcfYield:             ['fcf yield'],
  dividendYield:        ['dividend yield'],
  payoutRatio:          ['payout ratio'],
  buybackYield:         ['buyback yield dilution', 'buyback yield'],
};

// Build reverse lookup: normalized label → canonical key
const LABEL_TO_KEY = {};
for (const [key, aliases] of Object.entries(METRIC_ALIASES)) {
  for (const a of aliases) LABEL_TO_KEY[a] = key;
}

// Which canonical keys are stored as ratios/percentages (decimal form e.g. 0.84 = 84%)
const PERCENT_KEYS = new Set([
  'revenueGrowthYoY', 'netIncomeGrowth', 'epsGrowth', 'sharesChangeYoY',
  'grossMargin', 'operatingMargin', 'profitMargin', 'fcfMargin', 'ebitdaMargin',
  'ebitMargin', 'effectiveTaxRate', 'roe', 'roa', 'roic',
  'earningsYield', 'fcfYield', 'dividendYield', 'payoutRatio', 'buybackYield',
]);

// ── Value parsing ────────────────────────────────────────────────────────────
function parseValue(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === 'N/A' || s === 'n/a') return null;

  let negative = false;
  // Parentheses = negative
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }

  // Percent sign
  let isPercent = false;
  if (s.endsWith('%')) { isPercent = true; s = s.slice(0, -1); }

  // Suffixes (B/M/K/T) sometimes present
  let mult = 1;
  const suffix = s.slice(-1).toUpperCase();
  if (suffix === 'T') { mult = 1e12; s = s.slice(0, -1); }
  else if (suffix === 'B') { mult = 1e9; s = s.slice(0, -1); }
  else if (suffix === 'M') { mult = 1e6; s = s.slice(0, -1); }
  else if (suffix === 'K') { mult = 1e3; s = s.slice(0, -1); }

  // Strip commas and stray spaces
  s = s.replace(/,/g, '').replace(/\s+/g, '');
  if (s === '' || s === '.') return null;

  let n = parseFloat(s);
  if (isNaN(n)) return null;
  n *= mult;
  if (negative) n = -n;
  if (isPercent) n = n / 100;   // normalize percent text to decimal
  return n;
}

// Split a pasted line into [label, ...cells]. Accepts tabs OR runs of 2+ spaces.
function splitRow(line) {
  if (line.includes('\t')) return line.split('\t');
  // Fall back to 2+ spaces as delimiter
  return line.split(/ {2,}/);
}

// Detect a "period header" row. Returns { scale, periods } or null.
// Quarterly header begins with "Fiscal Quarter"; annual with "Fiscal Year".
function parsePeriodHeader(cells) {
  const first = norm(cells[0]);
  if (first === 'fiscal quarter') {
    return { scale: 'quarterly', periods: cells.slice(1).map(c => String(c).trim()).filter(Boolean) };
  }
  if (first === 'fiscal year') {
    return { scale: 'annual', periods: cells.slice(1).map(c => String(c).trim()).filter(Boolean) };
  }
  return null;
}

// ── Main parser ──────────────────────────────────────────────────────────────
export function parseFinancials(pasteText) {
  const result = {
    periods: { quarterly: [], annual: [] },
    metrics: {},
    warnings: [],
    rawMetricCount: 0,
  };
  if (!pasteText || !pasteText.trim()) {
    result.warnings.push('Nothing pasted.');
    return result;
  }

  const lines = pasteText.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '');

  let currentScale = 'quarterly';   // default until we see a header
  let currentPeriods = null;
  let sawAnyHeader = false;

  for (const line of lines) {
    const cells = splitRow(line);
    if (cells.length === 0) continue;

    // Section title lines like "Income Statement" / "Balance sheet" / "Cashflow"
    // / "Key Ratio" appear alone or as a label with no numeric cells. Skip them;
    // we rely on the period header rows that follow.
    const header = parsePeriodHeader(cells);
    if (header) {
      sawAnyHeader = true;
      currentScale = header.scale;
      currentPeriods = header.periods;
      if (header.scale === 'quarterly' && result.periods.quarterly.length === 0) {
        result.periods.quarterly = header.periods;
      }
      if (header.scale === 'annual' && result.periods.annual.length === 0) {
        result.periods.annual = header.periods;
      }
      continue;
    }

    // "Period Ending" row — skip (dates, not needed for comparison math)
    if (norm(cells[0]) === 'period ending') continue;

    // Skip lone section-title lines (single cell, no numbers)
    if (cells.length === 1) continue;

    // Metric row — map label → canonical key
    const label = cells[0].trim();
    const key = LABEL_TO_KEY[norm(label)];
    result.rawMetricCount++;
    if (!key) continue;            // not a metric we track; ignore quietly
    if (!currentPeriods) {
      // No header seen yet — can't map columns to periods
      continue;
    }

    const values = {};
    for (let i = 0; i < currentPeriods.length; i++) {
      const v = parseValue(cells[i + 1]);
      if (v !== null) values[currentPeriods[i]] = v;
    }

    // Merge if metric already seen (e.g. FCF appears in both income & cashflow)
    if (!result.metrics[key]) {
      result.metrics[key] = {
        label,
        canonicalKey: key,
        scale: currentScale,
        isPercent: PERCENT_KEYS.has(key),
        values,
      };
    } else {
      Object.assign(result.metrics[key].values, values);
    }
  }

  if (!sawAnyHeader) {
    result.warnings.push('Could not find a "Fiscal Quarter" or "Fiscal Year" header row. Make sure you copied the whole table including the header.');
  }
  if (Object.keys(result.metrics).length === 0) {
    result.warnings.push('No recognized financial metrics found. Check that you pasted the data correctly.');
  }

  return result;
}

// Convenience: list of canonical keys actually present
export function presentMetrics(parsed) {
  return Object.keys(parsed.metrics || {});
}
