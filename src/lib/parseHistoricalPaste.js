// Client-side parser for user-pasted historical price data.
// Designed to handle the wildly different formats from Yahoo Finance,
// stockanalysis.com, Investing.com, plain CSV, and tab-separated paste.

// Returns: { ok: true, candles: [{ts, open, high, low, close}, ...] }
//      or: { ok: false, error: "...", lineNum?: number }

const ISO_DATE     = /^(\d{4})-(\d{2})-(\d{2})/;
const US_DATE      = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/;
const INTL_DATE    = /^(\d{1,2})-(\d{1,2})-(\d{2,4})/;
const MONTH_NAMES  = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^["']|["']$/g, '');

  // Try ISO first (YYYY-MM-DD)
  let m = s.match(ISO_DATE);
  if (m) {
    const ts = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return isNaN(ts) ? null : ts;
  }

  // US format (M/D/YYYY)
  m = s.match(US_DATE);
  if (m) {
    let year = +m[3]; if (year < 100) year += year < 50 ? 2000 : 1900;
    const ts = Date.UTC(year, +m[1] - 1, +m[2]);
    return isNaN(ts) ? null : ts;
  }

  // International (D-M-YYYY)
  m = s.match(INTL_DATE);
  if (m) {
    let year = +m[3]; if (year < 100) year += year < 50 ? 2000 : 1900;
    const ts = Date.UTC(year, +m[2] - 1, +m[1]);
    return isNaN(ts) ? null : ts;
  }

  // "May 23, 2026" or "23 May 2026" or "May 23 2026"
  const monthMatch = s.match(/([A-Za-z]+)/);
  const numbers    = s.match(/\d+/g);
  if (monthMatch && numbers && numbers.length >= 2) {
    const monthIdx = MONTH_NAMES[monthMatch[1].toLowerCase()];
    if (monthIdx !== undefined) {
      // figure out which numbers are day/year
      const nums = numbers.map(Number);
      let day, year;
      if (nums[0] > 31)      { year = nums[0]; day = nums[1]; }
      else if (nums[1] > 31) { day = nums[0]; year = nums[1]; }
      else                   { day = nums[0]; year = nums[1] || new Date().getFullYear(); }
      if (year < 100) year += year < 50 ? 2000 : 1900;
      const ts = Date.UTC(year, monthIdx, day);
      return isNaN(ts) ? null : ts;
    }
  }

  // Last try: native Date.parse
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) {
    // normalize to UTC midnight of that calendar day
    const d = new Date(parsed);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  return null;
}

function parseNumber(raw) {
  if (raw == null) return null;
  // Strip currency symbols, commas-in-numbers, trailing %, surrounding quotes
  const s = String(raw)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[$€£¥₹]/g, '')
    .replace(/,/g, '')
    .replace(/%$/, '');

  // Support "1.5K", "2.3M", "4.5B" suffixes (volume formats)
  const suffix = s.match(/^([0-9.+-]+)([KMB])$/i);
  if (suffix) {
    const base = parseFloat(suffix[1]);
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix[2].toUpperCase()];
    return isNaN(base) ? null : base * mult;
  }

  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Auto-detect delimiter: prefer tab, then comma, then runs of 2+ spaces
function detectDelimiter(line) {
  if (line.includes('\t')) return '\t';
  if (line.includes(','))  return ',';
  if (/  +/.test(line))    return /\s{2,}/;
  return /\s+/;
}

// Quote-aware splitter: treats commas inside quoted strings as literal text.
function splitLineQuoteAware(line, delim) {
  if (delim instanceof RegExp) return line.split(delim);
  const cells = [];
  let cur = '';
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === delim) {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function splitLine(line, delim) {
  return splitLineQuoteAware(line, delim);
}

// Strip CSV-style quotes from each cell
function cleanCell(c) {
  return String(c || '').trim().replace(/^["']|["']$/g, '');
}

// Inspect header row to identify which column index is what
// Returns { dateIdx, openIdx, highIdx, lowIdx, closeIdx } — any may be -1 if not found
function detectHeaderColumns(headerCells) {
  const result = { dateIdx: -1, openIdx: -1, highIdx: -1, lowIdx: -1, closeIdx: -1 };
  headerCells.forEach((cell, i) => {
    const c = cleanCell(cell).toLowerCase();
    if (result.dateIdx === -1 && /^(date|day|time|timestamp)$/.test(c))    result.dateIdx  = i;
    else if (result.openIdx  === -1 && /^open$/.test(c))                   result.openIdx  = i;
    else if (result.highIdx  === -1 && /^high$/.test(c))                   result.highIdx  = i;
    else if (result.lowIdx   === -1 && /^low$/.test(c))                    result.lowIdx   = i;
    else if (result.closeIdx === -1 && /^(close|price|adj.?close|last)$/.test(c)) result.closeIdx = i;
  });
  return result;
}

export function parseHistoricalPaste(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: 'Empty input' };
  }

  // Split into lines, drop blank
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) return { ok: false, error: 'Empty input' };

  // Detect delimiter using first non-empty line
  const delim = detectDelimiter(lines[0]);

  // Check if the first line is a header (contains a known keyword)
  const firstCells = splitLine(lines[0], delim).map(cleanCell);
  const hasHeader = firstCells.some(c => /^(date|open|high|low|close|price|adj.?close|day|volume|last)$/i.test(c));

  let dataLines = lines;
  let columns;
  if (hasHeader) {
    columns = detectHeaderColumns(firstCells);
    dataLines = lines.slice(1);
  } else {
    // No header — infer by content. Most common case: first column = date, last numeric column = close
    // For a 2-col input: date, close. For 5+ col: date, open, high, low, close, [volume...]
    const firstDataCells = splitLine(lines[0], delim).map(cleanCell);
    if (firstDataCells.length === 2) {
      columns = { dateIdx: 0, closeIdx: 1, openIdx: -1, highIdx: -1, lowIdx: -1 };
    } else if (firstDataCells.length >= 5) {
      // Standard OHLC layout: Date, Open, High, Low, Close
      columns = { dateIdx: 0, openIdx: 1, highIdx: 2, lowIdx: 3, closeIdx: 4 };
    } else if (firstDataCells.length >= 3) {
      // Date + 2 columns — assume date, open, close (rare format) — actually safer to just use close
      columns = { dateIdx: 0, closeIdx: firstDataCells.length - 1, openIdx: -1, highIdx: -1, lowIdx: -1 };
    } else {
      return { ok: false, error: 'Could not detect columns. Need at least date + price.' };
    }
  }

  if (columns.dateIdx === -1) {
    return { ok: false, error: 'Could not find a date column. Make sure your first column is dates.' };
  }
  if (columns.closeIdx === -1) {
    return { ok: false, error: 'Could not find a price/close column.' };
  }

  // Parse each data row
  const candles = [];
  const errors  = [];
  dataLines.forEach((line, idx) => {
    const cells = splitLine(line, delim).map(cleanCell);
    const ts    = parseDate(cells[columns.dateIdx]);
    const close = parseNumber(cells[columns.closeIdx]);
    if (!ts || close == null) {
      errors.push(`Line ${idx + (hasHeader ? 2 : 1)}: could not parse "${line.slice(0, 60)}"`);
      return;
    }
    const candle = { ts, close };
    if (columns.openIdx >= 0)  candle.open  = parseNumber(cells[columns.openIdx])  ?? close;
    if (columns.highIdx >= 0)  candle.high  = parseNumber(cells[columns.highIdx])  ?? close;
    if (columns.lowIdx  >= 0)  candle.low   = parseNumber(cells[columns.lowIdx])   ?? close;
    if (candle.open  == null) candle.open  = close;
    if (candle.high  == null) candle.high  = close;
    if (candle.low   == null) candle.low   = close;
    candles.push(candle);
  });

  if (candles.length === 0) {
    return { ok: false, error: errors[0] || 'No valid rows found' };
  }

  // Sort oldest → newest, deduplicate by date
  candles.sort((a, b) => a.ts - b.ts);
  const dedup = [];
  let lastTs = -1;
  for (const c of candles) {
    if (c.ts !== lastTs) { dedup.push(c); lastTs = c.ts; }
  }

  return {
    ok: true,
    candles: dedup,
    skipped: errors.length,
    fromDate: new Date(dedup[0].ts).toISOString().slice(0, 10),
    toDate:   new Date(dedup[dedup.length - 1].ts).toISOString().slice(0, 10),
  };
}
