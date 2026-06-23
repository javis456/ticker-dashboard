// Vercel serverless function: GET /api/check-alerts
// Called by cron-job.org every 5 minutes during US market hours (Mon-Fri, 9:30AM-4:00PM ET).
//
// US tickers only — non-US tickers in alerts are skipped here because:
//   1. Their markets are closed during US trading hours (price isn't moving)
//   2. The 12x/hour call rate would burn through Twelve Data's 800/day free tier
// For non-US, use Hawkeye instead — its once-daily cadence is the natural fit.

import { createClient } from '@supabase/supabase-js';
import { isUSTicker } from '../lib/markets.js';

const FINNHUB_KEY  = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const RESEND_FROM  = process.env.RESEND_FROM || 'Ticker <onboarding@resend.dev>';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

function isUSMarketOpen() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    hour: 'numeric', minute: 'numeric', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const day = parts.weekday;
  if (day === 'Sat' || day === 'Sun') return false;
  const h = parseInt(parts.hour, 10);
  const m = parseInt(parts.minute, 10);
  const minutes = h * 60 + m;
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

async function getQuote(symbol) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  return r.json();
}

async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) return { skipped: 'no-resend-key' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
  });
  if (!r.ok) {
    const errText = await r.text();
    console.warn('Resend error:', r.status, errText);
    return { ok: false, status: r.status, error: errText };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env missing' });
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY missing' });

  if (!isUSMarketOpen()) {
    return res.status(200).json({ skipped: 'market-closed' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Pull active alerts
  const { data: alerts, error: aErr } = await supabase
    .from('price_alerts').select('*').eq('status', 'active');
  if (aErr) return res.status(500).json({ error: aErr.message });
  if (!alerts || alerts.length === 0) {
    return res.status(200).json({ checked: 0, fired: 0 });
  }

  // Filter to US tickers only (see header comment)
  const usAlerts = alerts.filter(a => isUSTicker(a.ticker));
  const skippedNonUS = alerts.length - usAlerts.length;

  // Group by ticker → fewer API calls
  const byTicker = {};
  for (const a of usAlerts) {
    (byTicker[a.ticker] ||= []).push(a);
  }

  // Pull emails for involved identities (one batch)
  const identities = [...new Set(usAlerts.map(a => a.identity))];
  const { data: settings } = await supabase
    .from('user_settings').select('identity, email').in('identity', identities);
  const emailByIdentity = {};
  (settings || []).forEach(r => { if (r.email) emailByIdentity[r.identity] = r.email; });

  let fired = 0;
  const summary = [];

  for (const [ticker, ticketAlerts] of Object.entries(byTicker)) {
    let quote;
    try {
      quote = await getQuote(ticker);
    } catch (e) {
      summary.push({ ticker, error: e.message });
      continue;
    }
    const price = quote?.c;
    if (!price) continue;

    for (const alert of ticketAlerts) {
      const start = alert.start_price;
      const target = alert.target_price;
      if (start == null || target == null) continue;

      // Has the price crossed the target since the alert was created?
      const startedBelow = start < target;
      const crossed = startedBelow ? price >= target : price <= target;
      if (!crossed) continue;

      // FIRE this alert
      const direction = startedBelow ? 'risen to' : 'fallen to';
      const email = emailByIdentity[alert.identity];
      if (email) {
        const subject = `Alert: ${ticker} ${direction} $${price.toFixed(2)}`;
        const html = `
          <div style="font-family:-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#111">
            <h2 style="margin:0 0 16px 0;font-family:Georgia,serif;font-size:22px">${ticker} ${direction} $${price.toFixed(2)}</h2>
            <p style="margin:0 0 12px 0;color:#525252">Your alert for <b>${ticker}</b> just triggered.</p>
            <table style="font-size:13px;color:#444;border-collapse:collapse;margin:12px 0">
              <tr><td style="padding:4px 12px 4px 0;opacity:0.6">Start price:</td><td>$${start.toFixed(2)}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;opacity:0.6">Target:</td><td>$${target.toFixed(2)}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;opacity:0.6">Current:</td><td><b>$${price.toFixed(2)}</b></td></tr>
            </table>
            <p style="font-size:12px;color:#a3a3a3;margin-top:24px">— Ticker</p>
          </div>
        `;
        await sendEmail(email, subject, html);
      }
      await supabase.from('price_alerts').update({
        status: 'triggered',
        triggered_at: new Date().toISOString(),
        triggered_price: price,
      }).eq('id', alert.id);
      fired++;
      summary.push({ ticker, alertId: alert.id, target, price });
    }
  }

  return res.status(200).json({
    checked: usAlerts.length,
    fired,
    skipped_non_us: skippedNonUS,
    summary,
  });
}
