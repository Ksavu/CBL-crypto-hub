-- CBL Buy Bot (group buy posts). Run once in Supabase → SQL Editor → New query → Run (safe to run again).
create table if not exists bot_buybot (
  chat_id bigint primary key,          -- the Telegram group
  chain text not null,
  token text not null,
  pool text,                           -- most liquid pair (GeckoTerminal trades)
  sym text,
  min_usd numeric not null default 10, -- smallest buy to post
  step_usd numeric not null default 10,-- one emoji per $X
  emoji text not null default '🟢',
  media text,                          -- optional image / gif url
  active boolean not null default true,
  mkt jsonb,                           -- cached price / market cap
  cursor jsonb,                        -- last posted trades
  created_at timestamptz not null default now()
);
create index if not exists bot_buybot_token_idx on bot_buybot (chain, token) where active;
alter table bot_buybot enable row level security;
