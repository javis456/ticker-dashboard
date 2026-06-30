// Catchup client helper.

import { supabase, getIdentity } from './supabase';

export async function loadCatchupCards() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('catchup_cards')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[catchup] load error', error); return []; }
  return data || [];
}

export async function saveCatchupCard(card) {
  if (!supabase) return;
  const identity = getIdentity();
  const { error } = await supabase
    .from('catchup_cards')
    .upsert({ ...card, identity });
  if (error) console.warn('[catchup] save error', error);
}

export async function deleteCatchupCard(id) {
  if (!supabase) return;
  await supabase.from('catchup_cards').delete().eq('id', id);
}

// Call the catchup serverless function
export async function generateCatchupBriefing(params) {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const { supabase } = await import('./supabase');
    const { data } = await supabase.auth.getSession();
    if (data?.session?.access_token) headers['Authorization'] = `Bearer ${data.session.access_token}`;
  } catch {}
  const res = await fetch('/api/catchup-summarize', {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.status === 429 && body?.upgrade) {
      const e = new Error(body.error || 'Free tier limit reached');
      e.upgrade = true;
      throw e;
    }
    throw new Error(`Catchup generation failed: ${res.status} ${body?.error || ''}`);
  }
  return res.json();
}

// ─── Helpers used by the UI ───────────────────────────────────────────────────

export function periodToDays(value, unit) {
  if (unit === 'day')   return value;
  if (unit === 'week')  return value * 7;
  if (unit === 'month') return value * 30;
  return value;
}

// Returns: { dueMs, overdueDays, status: 'fresh' | 'due-soon' | 'due-today' | 'overdue' }
export function computeDueState(card) {
  const lastRun = card.last_run_at
    ? new Date(card.last_run_at).getTime()
    : new Date(card.created_at).getTime();
  const days = periodToDays(card.routine_value, card.routine_unit);
  const dueMs = lastRun + days * 86400000;
  const nowMs = Date.now();
  const diffDays = (dueMs - nowMs) / 86400000;

  let status;
  if      (diffDays < -0.5) status = 'overdue';
  else if (diffDays < 0.5)  status = 'due-today';
  else if (diffDays < 1.5)  status = 'due-soon';
  else                       status = 'fresh';

  return {
    dueMs,
    overdueDays: diffDays < 0 ? Math.ceil(-diffDays) : 0,
    untilDays:   diffDays > 0 ? Math.ceil(diffDays)  : 0,
    status,
  };
}
