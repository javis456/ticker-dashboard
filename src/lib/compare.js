// compare.js — client persistence + live-data fetch for the Compare feature.
//
// Model:
//   STOCK LIBRARY (compare_stocks): reusable financial datasets, one per stock.
//   GROUPS (compare_groups): named collections referencing stock IDs.

import { supabase, getIdentity } from './supabase';

export const COMPARE_COLORS = ['#c2410c', '#0369a1', '#15803d', '#7c3aed', '#be185d'];

// ── Stock library ────────────────────────────────────────────────────────────
export async function loadCompareStocks() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('compare_stocks')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: true });
  if (error) { console.warn('[compare] load stocks error', error); return []; }
  return (data || []).map(r => ({
    id: r.id, ticker: r.ticker, name: r.name,
    marketTicker: r.market_ticker, currency: r.currency,
    color: r.color, parsed: r.parsed, created_at: r.created_at,
  }));
}

export async function saveCompareStock(stock) {
  if (!supabase) return false;
  const identity = getIdentity();
  const { error } = await supabase.from('compare_stocks').upsert({
    id: stock.id,
    identity,
    ticker: stock.ticker,
    name: stock.name || null,
    market_ticker: stock.marketTicker || null,
    currency: stock.currency || 'USD',
    parsed: stock.parsed,
    color: stock.color || null,
    updated_at: new Date().toISOString(),
  });
  if (error) { console.warn('[compare] save stock error', error); return false; }
  return true;
}

export async function deleteCompareStock(id) {
  if (!supabase) return;
  await supabase.from('compare_stocks').delete().eq('id', id);
  // Also remove from any group that referenced it
  const identity = getIdentity();
  const { data: groups } = await supabase
    .from('compare_groups').select('*').eq('identity', identity);
  for (const g of (groups || [])) {
    if ((g.stock_ids || []).includes(id)) {
      await supabase.from('compare_groups')
        .update({ stock_ids: g.stock_ids.filter(x => x !== id), updated_at: new Date().toISOString() })
        .eq('id', g.id);
    }
  }
}

export async function updateCompareStockCurrency(id, currency) {
  if (!supabase) return;
  await supabase.from('compare_stocks')
    .update({ currency, updated_at: new Date().toISOString() })
    .eq('id', id);
}

export async function updateCompareStockTicker(id, marketTicker) {
  if (!supabase) return;
  await supabase.from('compare_stocks')
    .update({ market_ticker: marketTicker, updated_at: new Date().toISOString() })
    .eq('id', id);
}

// ── Groups ───────────────────────────────────────────────────────────────────
export async function loadCompareGroups() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('compare_groups')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: true });
  if (error) { console.warn('[compare] load groups error', error); return []; }
  return (data || []).map(r => ({
    id: r.id, name: r.name, stockIds: r.stock_ids || [], created_at: r.created_at,
  }));
}

export async function saveCompareGroup(group) {
  if (!supabase) return false;
  const identity = getIdentity();
  const { error } = await supabase.from('compare_groups').upsert({
    id: group.id,
    identity,
    name: group.name,
    stock_ids: group.stockIds || [],
    updated_at: new Date().toISOString(),
  });
  if (error) { console.warn('[compare] save group error', error); return false; }
  return true;
}

export async function deleteCompareGroup(id) {
  if (!supabase) return;
  // Only deletes the group; stocks stay in the library.
  await supabase.from('compare_groups').delete().eq('id', id);
}

// ── Live price + FX ──────────────────────────────────────────────────────────
// Returns { price, priceTime, fxToUsd, fxAsOf, quoteCurrency, warnings }
export async function fetchPriceAndFx(marketTicker, currency) {
  const params = new URLSearchParams();
  if (marketTicker) params.set('ticker', marketTicker);
  if (currency) params.set('currency', currency);
  try {
    const r = await fetch(`/api/compare-price?${params.toString()}`);
    if (!r.ok) return { price: null, fxToUsd: currency === 'USD' ? 1 : null, warnings: [`HTTP ${r.status}`] };
    return await r.json();
  } catch (e) {
    return { price: null, fxToUsd: currency === 'USD' ? 1 : null, warnings: [String(e.message || e)] };
  }
}
