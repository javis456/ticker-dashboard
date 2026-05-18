// Vercel serverless function: GET /api/check-alerts
// Called by cron-job.org every 5 minutes during US market hours (Mon-Fri, 9:30AM-4:00PM ET).
//
// Architecture:
//  1. Pull all ACTIVE alerts from Supabase
//  2. Group by ticker (one Finnhub call per unique ticker, no matter how many alerts)
//  3. Compare current price to target — if it crossed since alert was created, FIRE
//  4. Mark fired alerts as 'triggered', send email via Resend
//  5. Skip silently if market is closed (saves all API costs)
//
// Cost optimization:
//  - Free Finnhub tier (60/min) — we make at most ~10 calls per cron tick
//  - Free Resend tier (100/day) — only sends on actual alert fires
//  - Function runtime under 5 sec — well within Vercel's free 10-sec Hobby limit

import { createClient } from '@supabase/supabase-js';

const FINNHUB_KEY      = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY;
const RESEND_KEY       = process.env.RESEND_API_KEY;
const RESEND_FROM      = process.env.RESEND_FROM || 'Ticker <onboarding@resend.dev>';
const SUPABASE_URL     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET      = process.env.CRON_SECRET; // optional

// ─── Market-hours guard (US Eastern, Mon–Fri 9:30–16:00) ──────────────────────
function isUSMarketOpen(now = new Date()) {
  // Convert to US/Eastern. Crude but reliable: use the Intl API for the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const day = parts.weekday; // 'Mon', 'Tue', ...
  if (['Sat', 'Sun'].includes(day)) return false;

  const hour = parseInt(parts.hour, 10);
  const min  = parseInt(parts.minute, 10);
  const mins = hour * 60 + min;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// ─── Finnhub quote fetcher (free tier endpoint) ───────────────────────────────
async function getQuote(symbol) {
  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
  );
  if (!res.ok) throw new Error(`Finnhub ${res.status} for ${symbol}`);
  return res.json();
}

// ─── Email sender via Resend ──────────────────────────────────────────────────
async function sendAlertEmail({ to, ticker, targetPrice, currentPrice, startPrice, direction }) {
  if (!RESEND_KEY) {
    console.warn('[alerts] RESEND_API_KEY missing — skipping email send');
    return false;
  }
  const subject = `${ticker} hit your alert: $${currentPrice.toFixed(2)} (target $${targetPrice.toFixed(2)})`;
  const html = `
<!DOCTYPE html><html><body style="font-family: -apple-system, system-ui, sans-serif; background: #fafaf7; padding: 32px 16px; color: #1a1a1a;">
  <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 16px; padding: 32px; border: 1px solid #ececec;">
    <div style="font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: #999; margin-bottom: 8px;">Price Alert</div>
    <h1 style="font-family: Georgia, serif; font-size: 32px; margin: 0 0 4px; color: #1a1a1a;">${ticker} hit your target</h1>
    <p style="color: #666; margin: 0 0 24px;">Your price alert fired during market hours.</p>

    <div style="background: #fafaf7; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
        <span style="color: #999; font-size: 13px;">Current price</span>
        <span style="font-weight: 600; font-size: 18px;">$${currentPrice.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
        <span style="color: #999; font-size: 13px;">Your target</span>
        <span style="font-weight: 600; font-size: 18px;">$${targetPrice.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between;">
        <span style="color: #999; font-size: 13px;">Price when alert set</span>
        <span style="font-weight: 500; font-size: 14px; color: #666;">$${startPrice.toFixed(2)}</span>
      </div>
    </div>

    <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      Price ${direction === 'up' ? 'rose to' : 'fell to'} your target since the alert was created.
      This alert has been marked as <b>triggered</b> and will not fire again.
    </p>

    <p style="color: #999; font-size: 12px; text-align: center; margin: 24px 0 0;">
      Ticker · personal market intelligence · not investment advice
    </p>
  </div>
</body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[alerts] Resend error:', res.status, err);
    return false;
  }
  return true;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Optional auth: if CRON_SECRET is set, require it in the Authorization header
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  // Bail out cheaply if market is closed (saves all downstream costs)
  if (!isUSMarketOpen()) {
    return res.status(200).json({ skipped: 'market closed', checked: 0 });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }
  if (!FINNHUB_KEY) {
    return res.status(500).json({ error: 'FINNHUB_KEY missing' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Pull all active alerts
  const { data: alerts, error: aErr } = await supabase
    .from('price_alerts')
    .select('*')
    .eq('status', 'active');

  if (aErr) {
    console.error('[alerts] fetch error:', aErr);
    return res.status(500).json({ error: aErr.message });
  }

  if (!alerts || alerts.length === 0) {
    return res.status(200).json({ skipped: 'no active alerts', checked: 0 });
  }

  // 2. Group by ticker (one quote fetch per ticker)
  const uniqueTickers = [...new Set(alerts.map(a => a.ticker))];
  const quotes = {};
  await Promise.all(uniqueTickers.map(async tk => {
    try { quotes[tk] = await getQuote(tk); }
    catch (e) { console.warn(`[alerts] quote failed for ${tk}:`, e.message); }
  }));

  // 3. Pull all user emails for identities that have firing alerts
  const identities = [...new Set(alerts.map(a => a.identity))];
  const { data: settings } = await supabase
    .from('user_settings')
    .select('*')
    .in('identity', identities);
  const emailByIdentity = {};
  (settings || []).forEach(s => { emailByIdentity[s.identity] = s.email; });

  // 4. Check each alert
  let firedCount = 0;
  const fires = [];

  for (const alert of alerts) {
    const q = quotes[alert.ticker];
    if (!q || !q.c) continue;

    const currentPrice = q.c;
    const startPrice   = Number(alert.start_price);
    const targetPrice  = Number(alert.target_price);

    // Cross-either-direction logic:
    // If start was below target, fire when current >= target (went up to it)
    // If start was above target, fire when current <= target (came down to it)
    // If start was at target (edge case), fire on any move past it
    let triggered = false;
    let direction = null;
    if (startPrice < targetPrice && currentPrice >= targetPrice) {
      triggered = true; direction = 'up';
    } else if (startPrice > targetPrice && currentPrice <= targetPrice) {
      triggered = true; direction = 'down';
    } else if (startPrice === targetPrice && currentPrice !== targetPrice) {
      triggered = true; direction = currentPrice > targetPrice ? 'up' : 'down';
    }

    if (!triggered) continue;

    // 5. Mark triggered in DB
    const updates = {
      status: 'triggered',
      triggered_at: new Date().toISOString(),
      triggered_price: currentPrice,
    };

    // 6. Send email if we have one for this user
    const email = emailByIdentity[alert.identity];
    if (email) {
      const sent = await sendAlertEmail({
        to: email,
        ticker: alert.ticker,
        targetPrice,
        currentPrice,
        startPrice,
        direction,
      });
      updates.email_sent = sent;
    }

    const { error: uErr } = await supabase
      .from('price_alerts')
      .update(updates)
      .eq('id', alert.id);

    if (uErr) console.warn('[alerts] update failed for', alert.id, uErr);

    firedCount++;
    fires.push({ id: alert.id, ticker: alert.ticker, currentPrice, targetPrice, emailSent: updates.email_sent });
  }

  return res.status(200).json({
    checked: alerts.length,
    tickers: uniqueTickers.length,
    fired: firedCount,
    fires,
  });
}
