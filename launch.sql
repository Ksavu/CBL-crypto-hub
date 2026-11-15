-- pump.fun launches from the CBL Bartender. Run once in Supabase → SQL Editor → New query → Run (safe to run again).
create table if not exists bot_launches (
  id bigint generated always as identity primary key,
  tg_id bigint not null,
  mint text not null,
  name text, symbol text,
  dev_sol numeric, bundle_wallets int, bundle_each numeric,
  tx text,
  created_at timestamptz not null default now()
);
create index if not exists bot_launches_user_idx on bot_launches (tg_id, created_at desc);
alter table bot_launches enable row level security;
