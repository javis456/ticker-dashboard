// tiers.js — shared tier definitions and free-tier limits.
// Imported by both the client (UI gating) and server endpoints (enforcement).

export const TIER_LIMITS = {
  free: {
    watchlist: 20,          // max tickers in watching list
    summarizePerMonth: 1,   // summarize cards generated per calendar month
    alerts: 1,              // max active alert cards
    catchupTotal: 1,        // total catchup uses ever (all-time)
    hawkeye: 1,             // max hawkeye cards
    compareLibrary: 10,     // max stocks saved in the compare library
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

// Admin always behaves as pro with unlimited everything.
export function effectiveLimits(profile) {
  if (!profile) return TIER_LIMITS.free;
  if (profile.is_admin) return TIER_LIMITS.pro;
  return TIER_LIMITS[profile.tier] || TIER_LIMITS.free;
}

export function isPro(profile) {
  return !!profile && (profile.is_admin || profile.tier === 'pro');
}

// Human-readable descriptions for the upgrade modal.
export const FREE_LIMIT_LABELS = {
  watchlist: 'Up to 20 stocks in your watchlist',
  summarizePerMonth: '1 Summarize card per month',
  alerts: '1 price alert',
  catchupTotal: '1 Catchup use',
  hawkeye: '1 Hawkeye card',
  compareLibrary: 'Up to 10 stocks in your Compare library',
};
