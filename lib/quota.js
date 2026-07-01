// quota.js — server-side tier + quota enforcement for token-spending endpoints.
//
// This is the real guard. UI gating can be bypassed by a determined user, so the
// API endpoints that cost AI tokens MUST check here before calling the model.
//
// Uses the Supabase service-role key (server-only) to read the user's profile
// (bypassing RLS) and to atomically increment usage counters.

import { createClient } from '@supabase/supabase-js';

// Tier limits are inlined here (rather than imported from the client-side
// tiers.js) so this server module has no cross-folder dependency. The api/
// functions live in `api/` and import this from `../lib/`, while the UI copy of
// the limits lives in `src/lib/tiers.js`. Keep the `free` numbers in sync if you
// ever change them.
const TIER_LIMITS = {
  free: {
    watchlist: 20,
    summarizePerMonth: 1,
    alerts: 1,
    catchupTotal: 1,
    hawkeye: 1,
    compareLibrary: 10,
    aiUnlimited: false,
  },
  pro: {
    watchlist: Infinity,
    summarizePerMonth: Infinity,
    alerts: Infinity,
    catchupTotal: Infinity,
    hawkeye: Infinity,
    compareLibrary: Infinity,
    aiUnlimited: true,
  },
};

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Service-role client (server-only — never ship this key to the browser).
const admin = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Resolve a user's tier/admin from an access token (the client sends its
// Supabase session access_token in the Authorization header).
export async function resolveProfile(accessToken) {
  if (!admin || !accessToken) return null;
  try {
    // Verify the token and get the user id
    const { data: userData, error: userErr } = await admin.auth.getUser(accessToken);
    if (userErr || !userData?.user) return null;
    const uid = userData.user.id;
    const { data: profile } = await admin
      .from('profiles')
      .select('id, username, tier, is_admin')
      .eq('id', uid)
      .maybeSingle();
    return profile ? { ...profile, uid } : { uid, tier: 'free', is_admin: false };
  } catch (e) {
    console.error('[quota] resolveProfile error:', e?.message || e);
    return null;
  }
}

function limitsFor(profile) {
  if (!profile) return TIER_LIMITS.free;
  if (profile.is_admin) return TIER_LIMITS.pro;
  return TIER_LIMITS[profile.tier] || TIER_LIMITS.free;
}

// Check whether a metered AI action is allowed. meter is 'summarize' | 'catchup'.
// Returns { allowed, reason, profile }. Does NOT increment — call commitUsage()
// after a successful model call so failed calls don't burn quota.
export async function checkQuota(accessToken, meter) {
  try {
    const profile = await resolveProfile(accessToken);

    // No auth / no service config → behave as free and rely on counters by identity.
    const lim = limitsFor(profile);

    // Pro / admin: unlimited.
    if (lim.aiUnlimited) return { allowed: true, profile, unlimited: true };

    const identity = profile?.uid;
    if (!identity || !admin) {
      // Can't verify — fail open (allow) rather than block a paying/legit user.
      return { allowed: true, profile, unmetered: true };
    }

    if (meter === 'summarize') {
      const period = monthKey();
      const used = await readCount(identity, 'summarize', period);
      if (used >= lim.summarizePerMonth) {
        return { allowed: false, reason: `Free tier allows ${lim.summarizePerMonth} Summarize per month. Upgrade to Pro for unlimited.`, profile };
      }
      return { allowed: true, profile, period };
    }

    if (meter === 'catchup') {
      const used = await readCount(identity, 'catchup', 'all-time');
      if (used >= lim.catchupTotal) {
        return { allowed: false, reason: `Free tier allows ${lim.catchupTotal} Catchup use. Upgrade to Pro for unlimited.`, profile };
      }
      return { allowed: true, profile, period: 'all-time' };
    }

    // Unknown meter → allow (no specific cap defined).
    return { allowed: true, profile };
  } catch (e) {
    // Never let quota logic take down the endpoint — fail open.
    console.error('[quota] checkQuota error (failing open):', e?.message || e);
    return { allowed: true, profile: null, error: String(e?.message || e) };
  }
}

async function readCount(identity, meter, period) {
  const { data } = await admin
    .from('usage_counters')
    .select('count')
    .eq('identity', identity).eq('meter', meter).eq('period', period)
    .maybeSingle();
  return data?.count || 0;
}

// Increment the meter after a successful, token-spending call.
export async function commitUsage(profile, meter, period) {
  try {
    if (!admin || !profile?.uid) return;
    if (profile.is_admin || profile.tier === 'pro') return; // never meter pro/admin
    await admin.rpc('increment_usage', {
      p_identity: profile.uid,
      p_meter: meter,
      p_period: period || (meter === 'summarize' ? monthKey() : 'all-time'),
    });
  } catch (e) {
    console.error('[quota] commitUsage error (ignored):', e?.message || e);
  }
}

export { monthKey };
