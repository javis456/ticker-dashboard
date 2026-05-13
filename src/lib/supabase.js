// Supabase client — handles cloud sync for your groups, tickers, and pinned news.
// Free tier is generous (500MB DB, 50k monthly users).
// Sign up at https://supabase.com (uses GitHub login).

import { createClient } from '@supabase/supabase-js';

const url  = import.meta.env.VITE_SUPABASE_URL;
const key  = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (url && key) ? createClient(url, key) : null;

// We use a single anonymous "user identity" stored in localStorage so you don't
// need to build a login system. The identity is just a random UUID that scopes
// your data. If you want, you can paste the same identity into multiple devices
// to sync them (we expose this in the UI).

const IDENTITY_KEY = 'ticker.identity';

export function getIdentity() {
  let id = localStorage.getItem(IDENTITY_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(IDENTITY_KEY, id);
  }
  return id;
}

export function setIdentity(id) {
  localStorage.setItem(IDENTITY_KEY, id);
}

// ---- State persistence: we store the whole state as one JSON blob keyed by identity ----
export async function loadState() {
  if (!supabase) return null;
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('ticker_state')
    .select('state')
    .eq('identity', identity)
    .maybeSingle();
  if (error) { console.warn('loadState error', error); return null; }
  return data?.state || null;
}

let saveTimer = null;
export function saveState(state) {
  if (!supabase) return;
  // Debounce: don't hammer the DB on every keystroke.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const identity = getIdentity();
    const { error } = await supabase
      .from('ticker_state')
      .upsert({ identity, state, updated_at: new Date().toISOString() });
    if (error) console.warn('saveState error', error);
  }, 800);
}
