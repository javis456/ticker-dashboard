// Vercel serverless function: GET /api/compare-price
//
// Returns yesterday's (latest) close price for a market ticker AND the FX rate
// to convert that stock's reporting currency into USD. Used by the Compare
// feature to recompute valuation multiples (P/E, P/S, P/B) with a fresh price,
// and to convert all financials to USD.
//
// Query params:
//   ticker    — market ticker, e.g. "MU" or "KR:000660"
//   currency  — the stock's reporting currency, e.g. "KRW" (for FX → USD)
//
// Response:
//   {
//     price:        number | null,   // latest close in the stock's quote currency
//     priceTime:    number | null,   // unix seconds of the quote
//     fxToUsd:      number | null,   // multiply a `currency` amount by this to get USD
//     fxAsOf:       string | null,   // ISO date of the FX rate
//     quoteCurrency:string | null,   // currency the price is quoted in (best effort)
//     warnings:     string[]
//   }
//
// Both lookups are cached at the CDN edge: price ~10 min, FX ~6 h.

import { fetchQuote } from '../lib/quotes.js';
import { parseTicker, getMarket } from '../lib/markets.js';

// ExchangeRate-API open-access endpoint: no key, stable since 2010.
// Returns { rates: { USD:1, KRW:1380.2, JPY:..., ... } } based on the queried base.
async function fetchFxToUsd(currency) {
  if (!currency || currency === 'USD') return { fxToUsd: 1, fxAsOf: null };
  try {
    // Base = the stock's currency; we read how many USD one unit equals.
    const r = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`);
    if (!r.ok) throw new Error(`FX HTTP ${r.status}`);
    const data = await r.json();
    if (data.result !== 'success' || !data.rates || data.rates.USD == null) {
      throw new Error(data['error-type'] || 'FX lookup failed');
    }
    return {
      fxToUsd: data.rates.USD,                       // 1 <currency> = fxToUsd USD
      fxAsOf:  data.time_last_update_utc || null,
    };
  } catch (e) {
    return { fxToUsd: null, fxAsOf: null, fxError: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  const { ticker, currency } = req.query || {};
  const warnings = [];

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');

  // ── Price ──
  let price = null, priceTime = null, quoteCurrency = null;
  if (ticker) {
    const parsed = parseTicker(ticker);
    if (!parsed) {
      warnings.push(`Invalid market ticker "${ticker}" — price not fetched.`);
    } else {
      try {
        const q = await fetchQuote(ticker);
        if (q && q.c) {
          price = q.c;
          priceTime = q.t || null;
          quoteCurrency = getMarket(ticker)?.currency || null;
        } else {
          warnings.push(`No price returned for "${ticker}".`);
        }
      } catch (e) {
        warnings.push(`Price fetch failed for "${ticker}": ${e.message}`);
      }
    }
  } else {
    warnings.push('No market ticker provided — using pasted price.');
  }

  // ── FX → USD ──
  const fx = await fetchFxToUsd(currency);
  if (fx.fxError) warnings.push(`FX rate failed for ${currency}: ${fx.fxError}`);

  return res.status(200).json({
    price,
    priceTime,
    quoteCurrency,
    fxToUsd: fx.fxToUsd,
    fxAsOf:  fx.fxAsOf,
    warnings,
  });
}
