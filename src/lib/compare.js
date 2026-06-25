// compare.js — client persistence for the Compare feature.

import { supabase, getIdentity } from './supabase';

export const COMPARE_COLORS = ['#c2410c', '#0369a1', '#15803d', '#7c3aed', '#be185d'];

export async function loadCompareStocks() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('compare_stocks')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: true });
  if (error) { console.warn('[compare] load error', error); return []; }
  return (data || []).map(r => ({
    id: r.id, ticker: r.ticker, name: r.name, currency: r.currency,
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
    currency: stock.currency || 'USD',
    parsed: stock.parsed,
    color: stock.color || null,
    updated_at: new Date().toISOString(),
  });
  if (error) { console.warn('[compare] save error', error); return false; }
  return true;
}

export async function deleteCompareStock(id) {
  if (!supabase) return;
  await supabase.from('compare_stocks').delete().eq('id', id);
}

export async function updateCompareStockCurrency(id, currency) {
  if (!supabase) return;
  await supabase.from('compare_stocks')
    .update({ currency, updated_at: new Date().toISOString() })
    .eq('id', id);
}
