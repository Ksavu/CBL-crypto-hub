-- CBL Points. Run once in Supabase → SQL Editor → New query → Run (safe to run again).
create table if not exists points (
  tg_id bigint primary key,
  username text, name text,
  total int not null default 0,
  week int not null default 0,
  rank int,
  trades int default 0, refs int default 0, scans int default 0, calls int default 0,
  best_x numeric default 0,
  updated_at timestamptz default now()
);
create index if not exists points_week_idx on points (week desc);
create index if not exists points_total_idx on points (total desc);
create table if not exists points_users (tg_id bigint primary key, username text, name text);
create table if not exists points_events (
  id bigint generated always as identity primary key,
  tg_id bigint not null,
  kind text not null,          -- scan
  ref text not null,           -- day:token (one per token per day)
  created_at timestamptz not null default now(),
  unique (tg_id, kind, ref)
);
alter table points enable row level security;
alter table points_users enable row level security;
alter table points_events enable row level security;
