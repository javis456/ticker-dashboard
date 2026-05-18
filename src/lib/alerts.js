// Price Alerts client helper.

import { supabase, getIdentity } from './supabase';

// ─── User email settings ──────────────────────────────────────────────────────
export async function loadUserEmail() {
  if (!supabase) return "";
  const identity = getIdentity();
  const { data } = await supabase
    .from('user_settings')
    .select('email')
    .eq('identity', identity)
    .maybeSingle();
  return data?.email || "";
}

export async function saveUserEmail(email) {
  if (!supabase) return;
  const identity = getIdentity();
  const { error } = await supabase
    .from('user_settings')
    .upsert({ identity, email, updated_at: new Date().toISOString() });
  if (error) console.warn('[alerts] saveUserEmail error', error);
}

// ─── Alerts CRUD ──────────────────────────────────────────────────────────────
export async function loadAlerts() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('price_alerts')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[alerts] load error', error); return []; }
  return data || [];
}

export async function createAlert({ ticker, targetPrice, startPrice, notes }) {
  if (!supabase) return null;
  const identity = getIdentity();
  const id = "alert_" + Date.now();
  const row = {
    id, identity,
    ticker: ticker.toUpperCase(),
    target_price: Number(targetPrice),
    start_price:  Number(startPrice),
    status: 'active',
    created_at: new Date().toISOString(),
    notes: notes || null,
  };
  const { error } = await supabase.from('price_alerts').insert(row);
  if (error) { console.warn('[alerts] create error', error); return null; }
  return row;
}

export async function stopAlert(id) {
  if (!supabase) return;
  await supabase.from('price_alerts').update({ status: 'stopped' }).eq('id', id);
}

export async function deleteAlert(id) {
  if (!supabase) return;
  await supabase.from('price_alerts').delete().eq('id', id);
}
