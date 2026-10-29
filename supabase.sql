-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
create table if not exists watches (
  user_id bigint not null,
  address text not null,
  chain text not null,
  name text, symbol text,
  created_at timestamptz default now(),
  primary key (user_id, address)
);
create table if not exists snapshots (
  address text primary key,
  chain text not null,
  score int,
  flags jsonb default '{}'::jsonb,
  liquidity numeric, price numeric,
  ref jsonb default '{}'::jsonb,
  deployer text, deployer_amt text, supply text,
  alerted jsonb default '{}'::jsonb,
  checked_at timestamptz default now()
);
-- Only the server (service key) may touch these tables. Nobody can read them from the browser.
alter table watches enable row level security;
alter table snapshots enable row level security;

-- CBL Launch: tokens launched through cryptobarlounge.space (verified on the XRP Ledger before insert)
create table if not exists launches (
  issuer text primary key,
  currency text not null,
  ticker text not null,
  name text not null,
  description text,
  logo text,
  web text, x text, tg text,
  dev_pct numeric default 0,
  supply text,
  creator text not null,
  lp text not null,
  amm text,
  fee_tx text unique,
  created_at timestamptz default now()
);
create index if not exists launches_created_idx on launches (created_at desc);
alter table launches enable row level security;

-- Wallet tracker (Telegram /track): who tracks what, and the polling state per wallet.
create table if not exists wallets (
  address text primary key,
  family text not null,              -- evm | solana | xrpl | terraclassic
  chains jsonb default '[]'::jsonb,  -- EVM chains to poll (auto-detected)
  cursor jsonb default '{}'::jsonb,  -- per chain: last seen time + tx ids
  checked_at timestamptz default now(),
  created_at timestamptz default now()
);
create table if not exists tracked (
  user_id bigint not null,
  address text not null references wallets(address) on delete cascade,
  label text,
  created_at timestamptz default now(),
  primary key (user_id, address)
);
create index if not exists wallets_checked_idx on wallets (checked_at);
create index if not exists tracked_address_idx on tracked (address);
alter table wallets enable row level security;
alter table tracked enable row level security;

-- Token Radar: one cached snapshot, rebuilt every 5 minutes by /api/cron?job=radar
create table if not exists radar_cache (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table radar_cache enable row level security;
