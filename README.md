# Ticker

Your personal stock news dashboard. Real-time prices, news from your watchlist, custom groups, pinned stories with reminders.

**👉 Start here: [`SETUP.md`](./SETUP.md)** — a click-by-click guide that takes you from zero to a live deployed dashboard in ~45 minutes. No coding experience required.

## What's inside

- `src/App.jsx` — the main dashboard UI
- `src/lib/finnhub.js` — stock price + news client (free Finnhub API)
- `src/lib/supabase.js` — cloud sync for your data (free Supabase)
- `supabase-setup.sql` — one-time SQL to set up the cloud database
- `.env.example` — what API keys you need

## Tech

React + Vite + Tailwind. Deployed on Vercel. Data from Finnhub. Sync via Supabase.

All on free tiers — your monthly cost is $0.
