// Client-side helper for model preferences.

import { supabase, getIdentity } from './supabase';

export const DEFAULT_COMPLEX_MODEL = 'anthropic:claude-sonnet-4-5-20250929';
export const DEFAULT_SIMPLE_MODEL  = 'anthropic:claude-haiku-4-5-20251001';

let cachedProviders = null;
let providersFetchedAt = 0;
const PROVIDERS_CACHE_MS = 60 * 60 * 1000;  // 1 hour

export async function loadAvailableProviders(forceRefresh = false) {
  if (!forceRefresh && cachedProviders && (Date.now() - providersFetchedAt) < PROVIDERS_CACHE_MS) {
    return cachedProviders;
  }
  try {
    const r = await fetch('/api/list-models');
    if (!r.ok) return { providers: [] };
    const data = await r.json();
    cachedProviders = data;
    providersFetchedAt = Date.now();
    return data;
  } catch (e) {
    console.warn('[model-prefs] failed to load providers', e);
    return { providers: [] };
  }
}

export async function loadModelPrefs() {
  if (!supabase) {
    return { complex_model: DEFAULT_COMPLEX_MODEL, simple_model: DEFAULT_SIMPLE_MODEL };
  }
  const identity = getIdentity();
  const { data, error } = await supabase
    .from('user_settings')
    .select('complex_model, simple_model')
    .eq('identity', identity)
    .maybeSingle();
  if (error) {
    console.warn('[model-prefs] load error', error);
  }
  return {
    complex_model: data?.complex_model || DEFAULT_COMPLEX_MODEL,
    simple_model:  data?.simple_model  || DEFAULT_SIMPLE_MODEL,
  };
}

export async function saveModelPrefs(complex_model, simple_model) {
  if (!supabase) return false;
  const identity = getIdentity();

  // upsert preserves email if already present
  const { error } = await supabase
    .from('user_settings')
    .upsert({ identity, complex_model, simple_model }, { onConflict: 'identity' });
  if (error) {
    console.warn('[model-prefs] save error', error);
    return false;
  }
  return true;
}

// Find a display label for a given model id (e.g. "anthropic:claude-sonnet-4-5-20250929")
export function labelForModel(modelId, providersData) {
  if (!providersData || !providersData.providers) return modelId;
  for (const p of providersData.providers) {
    const m = (p.models || []).find(m => m.id === modelId);
    if (m) return `${p.name} — ${m.display_name}`;
  }
  return modelId;
}
