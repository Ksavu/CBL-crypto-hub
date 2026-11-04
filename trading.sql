-- CBL trading bot tables. Run once in Supabase → SQL Editor → New query → Run (safe to run again).
-- Row Level Security is ON with no policies: only the server (service key) can read these. The browser anon key cannot.
create table if not exists bot_wallets (
  tg_id bigint primary key,
  sol_pub text not null,
  sol_enc text not null,          -- encrypted with BOT_WALLET_KEY (AES-256-GCM), never plain
  evm_addr text not null,
  evm_enc text not null,
  settings jsonb not null default '{}'::jsonb,
  busy_until timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists bot_trades (
  id bigint generated always as identity primary key,
  tg_id bigint not null,
  chain text not null,
  token text not null,
  side text not null check (side in ('buy','sell')),
  native_raw text not null,       -- SOL/BNB/ETH in smallest units (buy: spent incl. fee, sell: received after fee)
  token_raw text not null,
  decimals int not null default 0,
  fee_raw text not null default '0',
  tx text,
  created_at timestamptz not null default now()
);
create index if not exists bot_trades_user_idx on bot_trades (tg_id, created_at);
-- Phase 2 (limit / take profit / stop loss, copy trading) will use this table.
create table if not exists bot_orders (
  id bigint generated always as identity primary key,
  tg_id bigint not null,
  chain text not null,
  token text not null,
  kind text not null,             -- limit_buy | take_profit | stop_loss | copy
  params jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table bot_wallets enable row level security;
alter table bot_trades enable row level security;
alter table bot_orders enable row level security;
