// Hawkeye client helper (v2 — after-close architecture).

import { supabase, getIdentity } from './supabase';

export async function loadHawkeyeCards() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('hawkeye_cards')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[hawkeye] load error', error); return []; }
  return data || [];
}

export async function saveHawkeyeCard(card) {
  if (!supabase) return;
  const identity = getIdentity();
  const { error } = await supabase
    .from('hawkeye_cards')
    .upsert({ ...card, identity });
  if (error) console.warn('[hawkeye] save error', error);
}

export async function deleteHawkeyeCard(id) {
  if (!supabase) return;
  await supabase.from('hawkeye_cards').delete().eq('id', id);
}

// Tell the server we want these tickers to be bootstrapped if not already.
export async function registerTickersForBootstrap(tickers) {
  try {
    const res = await fetch('/api/hawkeye-register-tickers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers }),
    });
    if (!res.ok) {
      console.warn('[hawkeye] register failed', res.status);
      return null;
    }
    return res.json();
  } catch (e) {
    console.warn('[hawkeye] register error', e);
    return null;
  }
}

// Returns { [ticker]: { bootstrapped, last_close_ts, bootstrap_error } }
export async function loadBootstrapStatus(tickers) {
  if (!supabase || tickers.length === 0) return {};
  const { data } = await supabase
    .from('hawkeye_history')
    .select('ticker, bootstrapped, last_close_ts, bootstrap_error')
    .in('ticker', tickers);
  const map = {};
  (data || []).forEach(r => { map[r.ticker] = r; });
  return map;
}

// ─── Helpers for the UI ──────────────────────────────────────────────────────
export function describeCondition(c) {
  const dir = c.direction === 'gain' ? 'gain' : 'loss';
  const refLabel = c.reference === 'lowest'  ? 'recent low'
                 : c.reference === 'highest' ? 'recent high'
                 : 'start of window';
  return `Price ${dir} ≥ ${c.thresholdPct}% from ${refLabel} (${c.triggerWindowDays}d window)`;
}
