-- Run this ONCE in Supabase: SQL Editor -> New Query -> Paste -> Run.
-- It creates the table Ticker uses to store your data.

create table if not exists public.ticker_state (
  identity   text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Allow the public anon key to read/write rows it owns by identity.
-- For a personal dashboard this is fine: each user's identity is a random UUID
-- generated in their browser, so nobody else can guess it.
alter table public.ticker_state enable row level security;

drop policy if exists "anon can read by identity" on public.ticker_state;
create policy "anon can read by identity"
  on public.ticker_state for select
  using (true);

drop policy if exists "anon can upsert" on public.ticker_state;
create policy "anon can upsert"
  on public.ticker_state for insert
  with check (true);

drop policy if exists "anon can update" on public.ticker_state;
create policy "anon can update"
  on public.ticker_state for update
  using (true);
