-- ── LoL Comp Builder – coaching calendar (bookings) ──────────────────────────
-- Run AFTER supabase-auth.sql in the Supabase SQL Editor
-- (Dashboard → SQL Editor → New query). Idempotent: safe to run again.
--
-- Every coach has their own calendar. Players request sessions; the coach
-- confirms or declines. Coaches can also block slots on their own calendar.
-- Statuses: requested → confirmed / declined; 'blocked' = coach busy.
-- All access goes through the RPCs below (session token checked server-side).

create table if not exists bookings (
  id         uuid primary key default gen_random_uuid(),
  coach      text not null references app_users(username) on delete cascade,
  player     text not null references app_users(username) on delete cascade,
  starts_at  timestamptz not null,
  minutes    int  not null default 60 check (minutes between 30 and 240),
  topic      text not null default '',
  status     text not null default 'requested'
             check (status in ('requested', 'confirmed', 'declined', 'blocked')),
  created_at timestamptz default now()
);
alter table bookings enable row level security;   -- no policies → RPC-only

-- Username for a session token (null if invalid). Internal helper.
create or replace function session_username(tok uuid)
returns text language sql security definer set search_path = public as $$
  select s.username from sessions s where s.token = tok;
$$;

-- True if the given range overlaps a confirmed/blocked booking of that coach.
create or replace function booking_overlaps(c text, ts timestamptz, mins int, skip uuid default null)
returns boolean language sql security definer set search_path = public as $$
  select exists (
    select 1 from bookings b
    where b.coach = c
      and b.status in ('confirmed', 'blocked')
      and (skip is null or b.id <> skip)
      and b.starts_at < ts + make_interval(mins => mins)
      and ts < b.starts_at + make_interval(mins => b.minutes)
  );
$$;

-- All coach usernames (any logged-in user may list them)
create or replace function get_coaches(token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if session_role(token) is null then raise exception 'not logged in'; end if;
  return coalesce(
    (select jsonb_agg(username order by username) from app_users where role = 'coach'),
    '[]'::jsonb);
end; $$;

-- All bookings (recent past + future). The whole team sees the calendars.
create or replace function get_bookings(token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if session_role(token) is null then raise exception 'not logged in'; end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object(
       'id', b.id, 'coach', b.coach, 'player', b.player,
       'starts_at', b.starts_at, 'minutes', b.minutes,
       'topic', b.topic, 'status', b.status) order by b.starts_at)
     from bookings b
     where b.starts_at > now() - interval '30 days'),
    '[]'::jsonb);
end; $$;

-- Player (or coach) requests a session on a coach's calendar
create or replace function request_booking(token uuid, coach text, starts_at timestamptz, minutes int, topic text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me text; bid uuid;
begin
  me := session_username(token);
  if me is null then raise exception 'not logged in'; end if;
  if not exists (select 1 from app_users a where a.username = request_booking.coach and a.role = 'coach') then
    raise exception 'unknown coach';
  end if;
  if me = request_booking.coach then raise exception 'you cannot request coaching from yourself'; end if;
  if request_booking.starts_at <= now() then raise exception 'that slot is in the past'; end if;
  if request_booking.minutes not between 30 and 240 then raise exception 'invalid duration'; end if;
  if booking_overlaps(request_booking.coach, request_booking.starts_at, request_booking.minutes) then
    raise exception 'that slot is already taken';
  end if;
  insert into bookings (coach, player, starts_at, minutes, topic)
    values (request_booking.coach, me, request_booking.starts_at,
            request_booking.minutes, left(coalesce(request_booking.topic, ''), 200))
    returning id into bid;
  return jsonb_build_object('id', bid);
end; $$;

-- Coach blocks a slot on their own calendar (busy / unavailable)
create or replace function block_slot(token uuid, starts_at timestamptz, minutes int, note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me text; bid uuid;
begin
  me := session_username(token);
  if session_role(token) is distinct from 'coach' then raise exception 'coach role required'; end if;
  if block_slot.minutes not between 30 and 240 then raise exception 'invalid duration'; end if;
  if booking_overlaps(me, block_slot.starts_at, block_slot.minutes) then
    raise exception 'that slot is already taken';
  end if;
  insert into bookings (coach, player, starts_at, minutes, topic, status)
    values (me, me, block_slot.starts_at, block_slot.minutes, left(coalesce(block_slot.note, ''), 200), 'blocked')
    returning id into bid;
  return jsonb_build_object('id', bid);
end; $$;

-- Coach confirms or declines a request on their own calendar
create or replace function set_booking_status(token uuid, booking uuid, new_status text)
returns void language plpgsql security definer set search_path = public as $$
declare me text; b bookings%rowtype;
begin
  me := session_username(token);
  if me is null then raise exception 'not logged in'; end if;
  if new_status not in ('confirmed', 'declined') then raise exception 'invalid status'; end if;
  select * into b from bookings where id = booking;
  if b.id is null then raise exception 'booking not found'; end if;
  if b.coach <> me then raise exception 'only the coach of this calendar can do that'; end if;
  if new_status = 'confirmed' and booking_overlaps(b.coach, b.starts_at, b.minutes, b.id) then
    raise exception 'overlaps another confirmed or blocked slot';
  end if;
  update bookings set status = new_status where id = booking;
end; $$;

-- Delete: the coach of the calendar, or the player who made the request
create or replace function delete_booking(token uuid, booking uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me text; b bookings%rowtype;
begin
  me := session_username(token);
  if me is null then raise exception 'not logged in'; end if;
  select * into b from bookings where id = booking;
  if b.id is null then return; end if;   -- already gone
  if me <> b.coach and me <> b.player then raise exception 'not your booking'; end if;
  delete from bookings where id = booking;
end; $$;

grant execute on function get_coaches(uuid)                                   to anon, authenticated;
grant execute on function get_bookings(uuid)                                  to anon, authenticated;
grant execute on function request_booking(uuid, text, timestamptz, int, text) to anon, authenticated;
grant execute on function block_slot(uuid, timestamptz, int, text)            to anon, authenticated;
grant execute on function set_booking_status(uuid, uuid, text)                to anon, authenticated;
grant execute on function delete_booking(uuid, uuid)                         to anon, authenticated;
