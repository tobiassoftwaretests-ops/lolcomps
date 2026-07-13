-- ── LoL Comp Builder – Supabase setup ────────────────────────────────────────
-- Paste this into the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- and run it ONCE. Replace CHANGE-ME below with your team password first!

-- Shared roster (single row, public readable)
create table if not exists roster (
  id int primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
insert into roster (id, data) values (1, '{}'::jsonb) on conflict do nothing;

alter table roster enable row level security;
create policy "public read" on roster for select using (true);
-- No insert/update/delete policies → the public anon key cannot write directly.

-- Team password, stored server-side only (no RLS policies → invisible to anon)
create table if not exists team_secret (pass text not null);
alter table team_secret enable row level security;
insert into team_secret (pass) values ('CHANGE-ME');

-- The only way to write: this function, which checks the password
create or replace function save_roster(new_data jsonb, pass text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from team_secret s where s.pass = save_roster.pass) then
    raise exception 'wrong password';
  end if;
  update roster set data = new_data, updated_at = now() where id = 1;
end;
$$;

revoke all on function save_roster(jsonb, text) from public;
grant execute on function save_roster(jsonb, text) to anon, authenticated;
