# Ticker — Setup Guide

This guide takes you from **zero** to a **live, public dashboard URL** that you can open on any device. No coding experience needed — you'll just be clicking through web interfaces.

**Total time: ~45 minutes.** All services used are free.

---

## What you'll end up with

- A live URL like `https://ticker-yourname.vercel.app` you can bookmark
- Real-time stock prices and news for any US-listed ticker
- Your groups and pinned items synced across phone + laptop
- Zero monthly cost

---

## Step 0 — Create the four accounts you'll need (~5 min)

Open each link, sign up. Use the same email everywhere if you want.

1. **GitHub** — https://github.com (stores your project files)
2. **Vercel** — https://vercel.com (hosts your website; sign in with GitHub)
3. **Finnhub** — https://finnhub.io (stock data API; click "Get free API key")
4. **Supabase** — https://supabase.com (cloud database for sync; sign in with GitHub)

No credit cards required for any of these on the free tier.

---

## Step 1 — Get your Finnhub API key (~2 min)

1. Go to https://finnhub.io and sign in.
2. On your dashboard, you'll see **"API Key"** at the top — it's a long string of letters and numbers.
3. **Click "Copy"** and paste it into a text file on your computer for now. Label it `FINNHUB_KEY`.

> The free tier gives you 60 API calls per minute. For a personal dashboard with 5-10 tickers refreshed every minute, you'll use a tiny fraction of that.

---

## Step 2 — Set up Supabase (~10 min)

This is your cloud database. It's where your watchlist, groups, and pinned news live so they sync between devices.

### 2a. Create the project

1. Go to https://supabase.com and click **"New project"**.
2. Pick any organization (Supabase makes one for you).
3. Fill in:
   - **Name**: `ticker` (or whatever you want)
   - **Database password**: click "Generate a password" and save it somewhere (you probably won't need it, but keep it)
   - **Region**: pick the one closest to you (for you in Thailand, **Southeast Asia (Singapore)** is best)
4. Click **"Create new project"**. Wait ~2 minutes for it to provision.

### 2b. Create the table Ticker needs

1. In the left sidebar, click **"SQL Editor"** (looks like `>_`).
2. Click **"+ New query"**.
3. Open the file `supabase-setup.sql` from this project, copy ALL of it, paste it into the SQL editor.
4. Click **"Run"** (bottom right). You should see "Success. No rows returned."

### 2c. Grab your two Supabase keys

1. In the left sidebar, click the **gear icon** → **"API"** (under "Project Settings").
2. You'll see two values you need:
   - **Project URL** — looks like `https://abcdefgh.supabase.co` → save as `SUPABASE_URL`
   - **anon / public** key (under "Project API keys") — a long string → save as `SUPABASE_ANON_KEY`
3. Add these to the same text file as your Finnhub key.

You should now have **three values** saved:
- `FINNHUB_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

---

## Step 3 — Get the code onto GitHub (~10 min)

We're going to use GitHub's web interface — no command line, no software to install.

### 3a. Create a new empty repository

1. Go to https://github.com/new.
2. Fill in:
   - **Repository name**: `ticker-dashboard`
   - **Public** or **Private** — your choice (Private is fine and free)
   - Tick **"Add a README file"**
3. Click **"Create repository"**.

### 3b. Upload the project files

1. On your new repo page, click **"Add file"** → **"Upload files"** (top right area).
2. Drag the **entire `ticker-dashboard` folder contents** into the upload area. You want to upload everything: `package.json`, `vite.config.js`, the `src` folder, etc. — but NOT the folder itself, just what's inside.
3. Scroll down, in the commit message type "initial upload", click **"Commit changes"**.

GitHub will upload everything. Once done, you should see all your files listed on the repo page.

---

## Step 4 — Deploy to Vercel (~10 min)

This is where the magic happens. Vercel takes your code on GitHub and turns it into a live website.

### 4a. Import the project

1. Go to https://vercel.com/new.
2. You'll see your GitHub repos listed. Find `ticker-dashboard` and click **"Import"**.
3. On the configuration page:
   - **Framework Preset** — should auto-detect as "Vite". If not, pick "Vite" from the dropdown.
   - **Build settings** — leave defaults.

### 4b. Add your environment variables

This is critical. Vercel needs your API keys to make the dashboard work.

1. Still on the same page, expand **"Environment Variables"**.
2. Add THREE variables, one at a time. For each: type the **Name** on the left, paste the **Value** on the right, click **"Add"**.

   | Name | Value |
   |---|---|
   | `VITE_FINNHUB_KEY` | (your Finnhub key) |
   | `VITE_SUPABASE_URL` | (your Supabase URL) |
   | `VITE_SUPABASE_ANON_KEY` | (your Supabase anon key) |

3. Once all three are added, click **"Deploy"**.

### 4c. Wait for the build

Vercel will install dependencies and build your site. Takes ~2 minutes. You'll see a confetti animation when it's done.

Click **"Continue to Dashboard"**. Your URL is at the top — something like `https://ticker-dashboard-yourname.vercel.app`.

**Click it. You should see your dashboard live with real prices and news.**

---

## Step 5 — Use it

Bookmark the URL on your phone and laptop.

### Adding tickers
- Click the `+` next to "Tickers" in the sidebar.
- Type a US-listed symbol (e.g., `META`, `JPM`, `BRK.B`).
- Pick which group it goes in. Done.

### Creating groups
- Click the folder-plus icon next to "Groups".
- Name it whatever you want ("My Speculative Plays", "Dividend Stocks", etc.).

### Pinning news
- Hover over any headline, click the star.
- Pinned items show up in the **Pinned** tab.
- After 3 days, pinned items get a yellow "Review?" badge — your reminder to re-check whether the thesis still holds.

### Syncing to your phone
1. On your laptop, click the **cloud icon** in the header → **"Copy"** the sync ID.
2. On your phone, open the same URL, click the cloud icon, paste the ID into "Paste a sync ID", click "Use this ID".
3. Done — both devices now show the same data.

---

## When something breaks

### "I see the page but no prices/news show up"
Your Finnhub key might be wrong or missing.
- Go to Vercel → your project → **"Settings"** → **"Environment Variables"**.
- Check `VITE_FINNHUB_KEY` is there and matches the one on your finnhub.io dashboard.
- If you fix it, go to **"Deployments"** → click the latest one → **"Redeploy"**.

### "The cloud icon is red (offline)"
Either Supabase isn't configured or the table isn't set up.
- Check `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel.
- Re-run the SQL from `supabase-setup.sql` in your Supabase SQL Editor.

### "I get 429 / rate limit errors"
You're hitting Finnhub's free tier limit (60/min). Refresh less often, or reduce the number of tickers.

### "I want to edit something"
Edit the file on GitHub directly (click the file → pencil icon → make changes → "Commit"). Vercel will automatically redeploy in ~1 minute. No other tools needed.

---

## What this is costing you

Nothing, as long as:
- Finnhub: under 60 API calls per minute (you'll be at ~10/min)
- Supabase: under 500 MB database / 5 GB bandwidth per month (your usage will be measured in kilobytes)
- Vercel: under 100 GB bandwidth per month (way more than you'll use)
- GitHub: free for unlimited public/private repos

You will literally not see a bill.

---

## What's next (when you're ready)

- **AI features** — Get an Anthropic API key, add a serverless function on Vercel that calls Claude for "Why it moved" + daily digests. Cost: ~$1-3/month for personal use.
- **Custom domain** — Buy `yourname.com` (~$10/yr), point it to Vercel in the project settings.
- **Email digests** — Add a daily cron job on Vercel that emails you the day's top stories.

When you want to do any of these, come back to Claude and ask — I can walk you through each one.
