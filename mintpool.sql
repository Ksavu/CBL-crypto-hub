-- Pre-ground "…pump" mint addresses for pump.fun launches. Run once in Supabase → SQL Editor → Run (safe to run again).
create table if not exists bot_mint_pool (
  id bigint generated always as identity primary key,
  pub text not null unique,      -- mint address (ends in "pump")
  enc text not null,             -- seed encrypted with BOT_WALLET_KEY
  created_at timestamptz not null default now()
);
alter table bot_mint_pool enable row level security;
