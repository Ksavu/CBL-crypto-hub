-- CBL trading bot: Bundles (extra Solana wallets W2–W5). Run once in Supabase → SQL Editor (safe to run again).
create table if not exists bot_subwallets (
  tg_id bigint not null,
  idx int not null check (idx between 2 and 5),
  sol_pub text not null,
  sol_enc text not null,          -- encrypted with BOT_WALLET_KEY, bound to user + wallet number
  created_at timestamptz not null default now(),
  primary key (tg_id, idx)
);
alter table bot_subwallets enable row level security;
-- which wallet (1 = main) made each trade
alter table bot_trades add column if not exists wallet int not null default 1;
