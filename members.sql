-- CBL member accounts + community chat. Run once in Supabase → SQL Editor → New query → Run.
-- Safe to run again. Row Level Security: each user only sees/edits their own data; chat is public to read,
-- signed-in users can post (rate-limited, banned users blocked), only admins can delete.

-- Profiles (one per auth user, created automatically on sign-up)
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);
create table if not exists watchlist (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  chain text not null, address text not null, label text check (char_length(label) <= 40),
  created_at timestamptz not null default now(),
  unique (user_id, chain, address)
);
create table if not exists linked_wallets (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  chain text not null, address text not null, label text check (char_length(label) <= 40),
  created_at timestamptz not null default now(),
  unique (user_id, chain, address)
);
create table if not exists chat_admins (user_id uuid primary key references auth.users on delete cascade);
create table if not exists chat_bans (user_id uuid primary key references auth.users on delete cascade, reason text, created_at timestamptz not null default now());
create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  username text not null,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_created_idx on chat_messages (created_at desc);

-- Auto-create a profile with a default name (user_ab12cd) on sign-up
create or replace function public.cbl_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username) values (new.id, 'user_' || substr(replace(new.id::text, '-', ''), 1, 6)) on conflict do nothing;
  return new;
end $$;
drop trigger if exists cbl_on_auth_user on auth.users;
create trigger cbl_on_auth_user after insert on auth.users for each row execute function public.cbl_new_user();
insert into profiles (id, username) select id, 'user_' || substr(replace(id::text, '-', ''), 1, 6) from auth.users on conflict do nothing;

-- Chat guard: server sets user, name and time; bans and a 3-second rate limit are enforced here
create or replace function public.cbl_chat_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  if new.user_id is null then raise exception 'Sign in to chat'; end if;
  if exists (select 1 from chat_bans where user_id = new.user_id) then raise exception 'You are muted in this chat'; end if;
  if exists (select 1 from chat_messages where user_id = new.user_id and created_at > now() - interval '3 seconds') then raise exception 'Slow down a little'; end if;
  new.username := coalesce((select username from profiles where id = new.user_id), 'anon');
  new.body := btrim(new.body);
  new.created_at := now();
  return new;
end $$;
drop trigger if exists cbl_chat_guard on chat_messages;
create trigger cbl_chat_guard before insert on chat_messages for each row execute function public.cbl_chat_guard();

alter table profiles enable row level security;
alter table watchlist enable row level security;
alter table linked_wallets enable row level security;
alter table chat_messages enable row level security;
alter table chat_admins enable row level security;
alter table chat_bans enable row level security;

drop policy if exists "profiles read" on profiles;
create policy "profiles read" on profiles for select using (true);
drop policy if exists "profiles update own" on profiles;
create policy "profiles update own" on profiles for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "watchlist own" on watchlist;
create policy "watchlist own" on watchlist for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "wallets own" on linked_wallets;
create policy "wallets own" on linked_wallets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "chat read" on chat_messages;
create policy "chat read" on chat_messages for select using (true);
drop policy if exists "chat post" on chat_messages;
create policy "chat post" on chat_messages for insert to authenticated with check (true);
drop policy if exists "chat admin delete" on chat_messages;
create policy "chat admin delete" on chat_messages for delete using (exists (select 1 from chat_admins a where a.user_id = auth.uid()));
drop policy if exists "admins self" on chat_admins;
create policy "admins self" on chat_admins for select using (user_id = auth.uid());
drop policy if exists "bans admin" on chat_bans;
create policy "bans admin" on chat_bans for all using (exists (select 1 from chat_admins a where a.user_id = auth.uid())) with check (exists (select 1 from chat_admins a where a.user_id = auth.uid()));

-- Live chat updates
do $$ begin
  alter publication supabase_realtime add table chat_messages;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- Make yourself chat admin (after you sign in once), replacing the email:
-- insert into chat_admins (user_id) select id from auth.users where email = 'cryptobarlounge@gmail.com';
