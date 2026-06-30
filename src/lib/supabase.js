// Supabase client — now with real authentication (email/password + Google OAuth).
//
// Auth model:
//   - Supabase Auth handles signup/login/sessions. Passwords are bcrypt-hashed
//     server-side; nobody (not even the admin) can read them.
//   - getIdentity() returns the logged-in user's stable UUID, which scopes all
//     their data. Before login it falls back to the legacy anonymous localStorage
//     UUID so the "claim my data" migration can find the old rows.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.warn('[Ticker] Supabase env vars missing. Auth and sync disabled.');
}

export const supabase = (url && key)
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// ── Identity ────────────────────────────────────────────────────────────────
const IDENTITY_KEY = 'ticker.identity';      // legacy anonymous id (pre-accounts)

let currentUserId = null;
export function setCurrentUserId(id) { currentUserId = id || null; }

export function getAnonIdentity() {
  return localStorage.getItem(IDENTITY_KEY);
}

// Primary identity used to scope all data. Authenticated user id when logged in;
// otherwise the legacy anonymous id (creating one if needed).
export function getIdentity() {
  if (currentUserId) return currentUserId;
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

// ── Auth actions ──────────────────────────────────────────────────────────────
export async function signUpWithEmail({ email, password, username }) {
  if (!supabase) return { error: { message: 'Auth not configured' } };
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { username } },
  });
  return { data, error };
}

export async function signInWithEmail({ email, password }) {
  if (!supabase) return { error: { message: 'Auth not configured' } };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

export async function signInWithGoogle() {
  if (!supabase) return { error: { message: 'Auth not configured' } };
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  return { data, error };
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
  currentUserId = null;
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

export function onAuthChange(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    setCurrentUserId(session?.user?.id || null);
    callback(event, session);
  });
  return () => data?.subscription?.unsubscribe?.();
}

// ── Profile (tier / admin) ──────────────────────────────────────────────────
export async function loadProfile() {
  if (!supabase || !currentUserId) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, email, tier, is_admin')
    .eq('id', currentUserId)
    .maybeSingle();
  if (error) { console.warn('[Ticker] loadProfile error', error); return null; }
  return data;
}

export async function updateUsername(username) {
  if (!supabase || !currentUserId) return false;
  const { error } = await supabase.from('profiles')
    .update({ username }).eq('id', currentUserId);
  return !error;
}

// ── Usage counters (quota) ──────────────────────────────────────────────────
export async function getUsage(meter, period) {
  if (!supabase) return 0;
  const identity = getIdentity();
  const { data } = await supabase
    .from('usage_counters')
    .select('count')
    .eq('identity', identity).eq('meter', meter).eq('period', period)
    .maybeSingle();
  return data?.count || 0;
}

export function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── Data claim (one-time migration of anonymous data to the account) ────────────
export async function claimAnonymousData() {
  if (!supabase || !currentUserId) return { migrated: false };
  const anon = getAnonIdentity();
  if (!anon || anon === currentUserId) return { migrated: false };

  const tables = [
    'ticker_state', 'alerts', 'catchup_cards', 'hawkeye_cards',
    'compare_stocks', 'compare_groups', 'user_settings', 'news_tags',
    'usage_counters',
  ];
  const results = {};
  for (const t of tables) {
    const { error } = await supabase
      .from(t)
      .update({ identity: currentUserId })
      .eq('identity', anon);
    results[t] = error ? `err:${error.message}` : 'ok';
  }
  localStorage.removeItem(IDENTITY_KEY);
  return { migrated: true, results };
}

// ── State persistence (unchanged contract) ────────────────────────────────────
export async function loadState() {
  if (!supabase) return null;
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('ticker_state')
    .select('state')
    .eq('identity', identity)
    .maybeSingle();
  if (error) { console.error('[Ticker] loadState ERROR:', error); return null; }
  return data?.state || null;
}

let saveTimer = null;
export function saveState(state) {
  if (!supabase) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const identity = getIdentity();
    const { error } = await supabase
      .from('ticker_state')
      .upsert({ identity, state, updated_at: new Date().toISOString() });
    if (error) console.error('[Ticker] saveState ERROR:', error);
  }, 800);
}
