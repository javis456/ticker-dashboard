// Summaries persistence helper.
// Summary cards are kept until the user deletes them.

import { supabase, getIdentity } from './supabase';

export async function loadSummaries() {
  if (!supabase) return [];
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('summaries')
    .select('*')
    .eq('identity', identity)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[summaries] load error', error); return []; }
  return data || [];
}

export async function saveSummary(row) {
  if (!supabase) return;
  const identity = getIdentity();
  const { error } = await supabase
    .from('summaries')
    .upsert({ ...row, identity });
  if (error) console.warn('[summaries] save error', error);
}

export async function deleteSummary(id) {
  if (!supabase) return;
  const identity = getIdentity();
  const { error } = await supabase
    .from('summaries')
    .delete()
    .eq('id', id)
    .eq('identity', identity);
  if (error) console.warn('[summaries] delete error', error);
}

// Call the serverless function to generate a summary
export async function generateSummary(params) {
  const headers = { 'Content-Type': 'application/json' };
  try {
    const { supabase } = await import('./supabase');
    const { data } = await supabase.auth.getSession();
    if (data?.session?.access_token) headers['Authorization'] = `Bearer ${data.session.access_token}`;
  } catch {}
  const res = await fetch('/api/summarize', {
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
    throw new Error(`Summary failed: ${res.status} ${body?.error || ''}`);
  }
  return res.json();
}
