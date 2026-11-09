-- CBL Bartender referrals. Run once in Supabase → SQL Editor → New query → Run (safe to run again).
create table if not exists bot_refs (
  tg_id bigint primary key,          -- the invited user
  ref_by bigint not null,            -- who invited them
  created_at timestamptz not null default now()
);
create index if not exists bot_refs_by_idx on bot_refs (ref_by);
create table if not exists bot_ref_claims (
  id bigint generated always as identity primary key,
  tg_id bigint not null,             -- the inviter claiming
  chain text not null,               -- solana | bsc | base | robinhood
  amount_raw text not null,          -- smallest units (lamports / wei)
  status text not null default 'sending', -- sending | pending (admin pays) | paid | failed
  tx text,
  created_at timestamptz not null default now()
);
create index if not exists bot_ref_claims_user_idx on bot_ref_claims (tg_id);
alter table bot_refs enable row level security;
alter table bot_ref_claims enable row level security;
