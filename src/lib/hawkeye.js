// Hawkeye client helper (v4 — visible data + manual check).

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

export async function registerTickersForBootstrap(tickers) {
  try {
    const res = await fetch('/api/hawkeye-register-tickers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch (e) { return null; }
}

export async function saveTickerHistory(ticker, candles) {
  const res = await fetch('/api/hawkeye-save-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker, candles }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Save history failed: ${res.status} ${err}`);
  }
  return res.json();
}

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

// NEW: Full candle data for chart display
export async function loadTickerHistory(tickers) {
  if (!supabase || tickers.length === 0) return {};
  const { data } = await supabase
    .from('hawkeye_history')
    .select('ticker, candles, last_close_ts, bootstrapped')
    .in('ticker', tickers);
  const map = {};
  (data || []).forEach(r => {
    map[r.ticker] = {
      candles: r.candles || [],
      last_close_ts: r.last_close_ts ? Number(r.last_close_ts) : null,
      bootstrapped: r.bootstrapped,
    };
  });
  return map;
}

// NEW: Manual run-check trigger
export async function runHawkeyeCheckNow() {
  const identity = getIdentity();
  const res = await fetch('/api/hawkeye-run-now', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Run-now failed: ${res.status} ${err}`);
  }
  return res.json();
}

export function describeCondition(c) {
  const dir = c.direction === 'gain' ? 'gain' : 'loss';
  const refLabel = c.reference === 'lowest'  ? 'recent low'
                 : c.reference === 'highest' ? 'recent high'
                 : 'start of window';
  return `Price ${dir} ≥ ${c.thresholdPct}% from ${refLabel} (${c.triggerWindowDays}d window)`;
}
