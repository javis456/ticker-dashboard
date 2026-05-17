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
  const res = await fetch('/api/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Summary failed: ${res.status} ${err}`);
  }
  return res.json();
}
