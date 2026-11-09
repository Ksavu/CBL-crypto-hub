-- CBL Bartender copy trading. Run once in Supabase → SQL Editor → New query → Run (safe to run again).
create table if not exists bot_copy (
  id bigint generated always as identity primary key,
  tg_id bigint not null,              -- follower
  chain text not null,                -- solana | bsc | base | robinhood
  target text not null,               -- wallet being copied
  label text,
  amount text not null,               -- coin spent per copied buy
  sells boolean not null default true,  -- copy sells too
  safe boolean not null default true,   -- skip CBL score < 50 / honeypots
  max_day int not null default 20,      -- max copied buys per 24h
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tg_id, chain, target)
);
create index if not exists bot_copy_target_idx on bot_copy (chain, target) where active;
create table if not exists bot_copy_log (
  id bigint generated always as identity primary key,
  tg_id bigint not null,
  target text not null,
  hash text not null,                 -- the copied wallet's transaction
  side text not null,                 -- buy | sell
  token text not null,
  ok boolean,
  note text,                          -- our tx hash, or why it was skipped / failed
  created_at timestamptz not null default now(),
  unique (tg_id, hash, token)         -- never copy the same trade twice
);
create index if not exists bot_copy_log_user_idx on bot_copy_log (tg_id, created_at desc);
alter table bot_copy enable row level security;
alter table bot_copy_log enable row level security;
