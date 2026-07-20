-- ── LoL Comp Builder – accounts, roles, shared roster & comps ────────────────
-- Username/password login (no email). Passwords are bcrypt-hashed server-side.
-- Roles: 'coach' (admin, may edit shared data) and 'player' (view only).
-- Registering requires an invite code that also decides the role.
-- Idempotent: safe to run again.

create extension if not exists pgcrypto with schema extensions;

create table if not exists invite_codes (
  code text primary key,
  role text not null check (role in ('coach', 'player'))
);

create table if not exists app_users (
  username   text primary key,
  pass_hash  text not null,
  role       text not null default 'player',
  created_at timestamptz default now()
);
alter table app_users add column if not exists role text not null default 'player';
alter table app_users enable row level security;   -- no policies → invisible to anon

create table if not exists sessions (
  token      uuid primary key default gen_random_uuid(),
  username   text not null references app_users(username) on delete cascade,
  created_at timestamptz default now()
);
alter table sessions enable row level security;

-- Shared saved comps (single row, JSON array)
create table if not exists comps (
  id int primary key,
  data jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now()
);
insert into comps (id, data) values (1, '[]'::jsonb) on conflict do nothing;
alter table comps enable row level security;

-- Roster and comps are reachable only through the RPCs below
drop policy if exists "public read" on roster;

-- Role for a session token (null if invalid). Internal helper, not exposed.
create or replace function session_role(tok uuid)
returns text language sql security definer set search_path = public as $$
  select a.role from sessions s join app_users a on a.username = s.username where s.token = tok;
$$;

drop function if exists register(text, text, text);
create or replace function register(u text, p text, invite text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare tok uuid; r text;
begin
  select role into r from invite_codes where code = register.invite;
  if r is null then raise exception 'wrong invite code'; end if;
  if length(coalesce(u, '')) < 2 or length(coalesce(p, '')) < 4 then
    raise exception 'username needs 2+ chars, password 4+ chars';
  end if;
  if exists (select 1 from app_users a where lower(a.username) = lower(register.u)) then
    raise exception 'username already taken';
  end if;
  insert into app_users(username, pass_hash, role) values (u, crypt(p, gen_salt('bf')), r);
  insert into sessions(username) values (u) returning token into tok;
  return jsonb_build_object('token', tok, 'username', u, 'role', r);
end; $$;

drop function if exists login(text, text);
create or replace function login(u text, p text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare tok uuid; uname text; r text;
begin
  select a.username, a.role into uname, r from app_users a
    where lower(a.username) = lower(login.u) and a.pass_hash = crypt(login.p, a.pass_hash);
  if uname is null then raise exception 'wrong username or password'; end if;
  insert into sessions(username) values (uname) returning token into tok;
  return jsonb_build_object('token', tok, 'username', uname, 'role', r);
end; $$;

create or replace function me(token uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('username', a.username, 'role', a.role)
  from sessions s join app_users a on a.username = s.username where s.token = me.token;
$$;

drop function if exists get_roster(uuid);
create or replace function get_roster(token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if session_role(token) is null then raise exception 'not logged in'; end if;
  return (select data from roster where id = 1);
end; $$;

drop function if exists save_roster_auth(jsonb, uuid);
create or replace function save_roster_auth(new_data jsonb, token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if session_role(token) is distinct from 'coach' then raise exception 'coach role required'; end if;
  update roster set data = new_data, updated_at = now() where id = 1;
end; $$;

create or replace function get_comps(token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if session_role(token) is null then raise exception 'not logged in'; end if;
  return (select data from comps where id = 1);
end; $$;

create or replace function save_comps(new_data jsonb, token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if session_role(token) is distinct from 'coach' then raise exception 'coach role required'; end if;
  update comps set data = new_data, updated_at = now() where id = 1;
end; $$;

-- Retire the old password-based write path
drop function if exists save_roster(jsonb, text);

grant execute on function register(text, text, text)    to anon, authenticated;
grant execute on function login(text, text)             to anon, authenticated;
grant execute on function me(uuid)                      to anon, authenticated;
grant execute on function get_roster(uuid)              to anon, authenticated;
grant execute on function save_roster_auth(jsonb, uuid) to anon, authenticated;
grant execute on function get_comps(uuid)               to anon, authenticated;
grant execute on function save_comps(jsonb, uuid)       to anon, authenticated;

-- Invite codes: coach code stays private, player code is shared with the team
insert into invite_codes(code, role) values ('UIC-Drake-1444', 'coach')
  on conflict (code) do update set role = 'coach';
insert into invite_codes(code, role) values ('UIC-Team-2026', 'player')
  on conflict (code) do update set role = 'player';
