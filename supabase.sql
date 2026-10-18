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
