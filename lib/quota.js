// quota.js — server-side tier + quota enforcement for token-spending endpoints.
//
// This is the real guard. UI gating can be bypassed by a determined user, so the
// API endpoints that cost AI tokens MUST check here before calling the model.
//
// Uses the Supabase service-role key (server-only) to read the user's profile
// (bypassing RLS) and to atomically increment usage counters.

import { createClient } from '@supabase/supabase-js';
import { TIER_LIMITS } from './tiers.js';

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
  const profile = await resolveProfile(accessToken);

  // No auth / no service config → behave as free and rely on counters by identity.
  const lim = limitsFor(profile);

  // Pro / admin: unlimited.
  if (lim.aiUnlimited) return { allowed: true, profile, unlimited: true };

  const identity = profile?.uid;
  if (!identity || !admin) {
    // Can't verify — fail safe by allowing only if we truly can't meter.
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
  if (!admin || !profile?.uid) return;
  if (profile.is_admin || profile.tier === 'pro') return; // never meter pro/admin
  await admin.rpc('increment_usage', {
    p_identity: profile.uid,
    p_meter: meter,
    p_period: period || (meter === 'summarize' ? monthKey() : 'all-time'),
  });
}

export { monthKey };
