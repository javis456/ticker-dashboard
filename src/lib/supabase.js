// Supabase client — handles cloud sync for your groups, tickers, and pinned news.
// Free tier is generous (500MB DB, 50k monthly users).
// Sign up at https://supabase.com (uses GitHub login).

import { createClient } from '@supabase/supabase-js';

const url  = import.meta.env.VITE_SUPABASE_URL;
const key  = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.warn('[Ticker] Supabase env vars missing. Sync will be disabled.');
}

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
    console.log('[Ticker] New identity created:', id);
  }
  return id;
}

export function setIdentity(id) {
  localStorage.setItem(IDENTITY_KEY, id);
}

// ---- State persistence: we store the whole state as one JSON blob keyed by identity ----
export async function loadState() {
  if (!supabase) {
    console.log('[Ticker] loadState: supabase client not configured');
    return null;
  }
  const identity = getIdentity();
  console.log('[Ticker] loadState: looking up identity', identity);
  const { data, error } = await supabase
    .from('ticker_state')
    .select('state')
    .eq('identity', identity)
    .maybeSingle();
  if (error) {
    console.error('[Ticker] loadState ERROR:', error);
    return null;
  }
  if (!data) {
    console.log('[Ticker] loadState: no row for this identity yet (first time on this device)');
    return null;
  }
  console.log('[Ticker] loadState: loaded state with', Object.keys(data.state || {}).length, 'keys');
  return data.state;
}

let saveTimer = null;
export function saveState(state) {
  if (!supabase) return;
  // Debounce: don't hammer the DB on every keystroke.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const identity = getIdentity();
    console.log('[Ticker] saveState: writing for identity', identity);
    const { data, error } = await supabase
      .from('ticker_state')
      .upsert({ identity, state, updated_at: new Date().toISOString() })
      .select();
    if (error) {
      console.error('[Ticker] saveState ERROR:', error);
    } else {
      console.log('[Ticker] saveState OK:', data);
    }
  }, 800);
}
