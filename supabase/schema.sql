-- Triton — database schema.
-- Run this once in the Supabase SQL editor (Database → SQL editor → New query).
-- It creates the members and bookings tables, the slot-collision guard, and the
-- row-level security that keeps one flat from seeing another flat's bookings.

-- ─────────────────────────── members ───────────────────────────
-- One row per login. A flat gets one resident row (login = flat number);
-- each committee member gets their own row so approvals are attributable.
create table if not exists public.members (
  id          uuid primary key default gen_random_uuid(),
  auth_id     uuid unique references auth.users (id) on delete cascade,
  login       text unique not null,            -- 'B-1204' or 'desk.manager'
  name        text not null,
  unit        text,                            -- flat number; null for committee
  role        text not null check (role in ('resident', 'committee')),
  phone       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists members_unit_idx on public.members (unit);

-- ─────────────────────────── bookings ───────────────────────────
create table if not exists public.bookings (
  id           text primary key default ('BKG-' || lpad(nextval('public.booking_seq')::text, 4, '0')),
  facility     text not null,
  slots        text[] not null,
  date         date not null,
  unit         text not null,
  resident     text not null,
  purpose      text not null default 'Private booking',
  guests       integer not null default 1 check (guests > 0),
  amount       integer not null check (amount >= 0),
  status       text not null default 'requested'
               check (status in ('requested','approved','paid_pending','confirmed',
                                 'rejected','cancelled','cancelled_nopay')),
  note         text not null default '',
  proof        jsonb,
  approved_at  timestamptz,
  approved_by  text,
  verified_at  timestamptz,
  verified_by  text,
  created_at   timestamptz not null default now()
);

create sequence if not exists public.booking_seq start 1000;

create index if not exists bookings_date_idx on public.bookings (date);
create index if not exists bookings_status_idx on public.bookings (status);
create index if not exists bookings_unit_idx on public.bookings (unit);

-- ────────────────── one slot, one live booking ──────────────────
-- Two residents tapping the same slot in the same second must not both win.
-- Each (facility, date, slot) can appear once among live bookings; a cancelled
-- or rejected booking releases its slot. Enforced in the database, not the app.
create table if not exists public.slot_locks (
  facility  text not null,
  date      date not null,
  slot      text not null,
  booking   text not null references public.bookings (id) on delete cascade,
  primary key (facility, date, slot)
);

create or replace function public.sync_slot_locks() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  live boolean;
  s text;
begin
  live := new.status in ('requested','approved','paid_pending','confirmed');

  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    if live then
      foreach s in array new.slots loop
        insert into public.slot_locks (facility, date, slot, booking)
        values (new.facility, new.date, s, new.id)
        on conflict (facility, date, slot) do update
          set booking = excluded.booking
          where public.slot_locks.booking = excluded.booking;
        -- if the row belongs to a different live booking, the update above
        -- matches nothing and the unique key below raises
        if not exists (
          select 1 from public.slot_locks
          where facility = new.facility and date = new.date and slot = s and booking = new.id
        ) then
          raise exception 'slot_taken';
        end if;
      end loop;
    else
      delete from public.slot_locks where booking = new.id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_slot_locks on public.bookings;
create trigger bookings_slot_locks
  after insert or update on public.bookings
  for each row execute function public.sync_slot_locks();

-- ─────────────── the 48-hour rule, server side ───────────────
-- The app sweeps expired bookings while it is open; this does it even when
-- nobody has it open. Schedule it hourly: Database → Cron (pg_cron).
create or replace function public.expire_unpaid_bookings() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with done as (
    update public.bookings
       set status = 'cancelled_nopay',
           note   = 'No payment picture within 48 hours of approval.'
     where status = 'approved'
       and approved_at < now() - interval '48 hours'
    returning 1
  )
  select count(*) into n from done;
  return n;
end;
$$;

-- select cron.schedule('triton-expire', '7 * * * *', $$select public.expire_unpaid_bookings()$$);

-- ─────────────────────── row-level security ───────────────────────
alter table public.members  enable row level security;
alter table public.bookings enable row level security;
alter table public.slot_locks enable row level security;

create or replace function public.my_member() returns public.members
language sql stable security definer set search_path = public as $$
  select * from public.members where auth_id = auth.uid() and active limit 1;
$$;

create or replace function public.is_committee() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'committee' from public.members
                   where auth_id = auth.uid() and active limit 1), false);
$$;

create or replace function public.my_unit() returns text
language sql stable security definer set search_path = public as $$
  select unit from public.members where auth_id = auth.uid() and active limit 1;
$$;

-- members: you see your own row; committee sees everyone.
drop policy if exists members_self on public.members;
create policy members_self on public.members for select
  using (auth_id = auth.uid() or public.is_committee());

-- bookings: a resident sees and creates only their own flat's rows.
drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select
  using (public.is_committee() or unit = public.my_unit());

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert
  with check (
    (public.is_committee())
    or (unit = public.my_unit() and status = 'requested'
        and approved_at is null and verified_at is null)
  );

-- A resident may upload proof or cancel their own booking. They may not approve,
-- verify, or change the amount — those columns are committee-only.
drop policy if exists bookings_update_resident on public.bookings;
create policy bookings_update_resident on public.bookings for update
  using (unit = public.my_unit())
  with check (
    unit = public.my_unit()
    and status in ('paid_pending', 'cancelled')
  );

drop policy if exists bookings_update_committee on public.bookings;
create policy bookings_update_committee on public.bookings for update
  using (public.is_committee()) with check (public.is_committee());

-- slot_locks is maintained by the trigger only; nobody reads it directly.
drop policy if exists slot_locks_none on public.slot_locks;
create policy slot_locks_none on public.slot_locks for select using (public.is_committee());

-- ─────────────────────────── storage ───────────────────────────
-- Payment pictures go in a private bucket, one folder per flat.
insert into storage.buckets (id, name, public)
values ('proofs', 'proofs', false)
on conflict (id) do nothing;

drop policy if exists proofs_insert on storage.objects;
create policy proofs_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'proofs'
    and (public.is_committee() or (storage.foldername(name))[1] = public.my_unit())
  );

drop policy if exists proofs_read on storage.objects;
create policy proofs_read on storage.objects for select to authenticated
  using (
    bucket_id = 'proofs'
    and (public.is_committee() or (storage.foldername(name))[1] = public.my_unit())
  );

-- ─────────────────────── seeding the logins ───────────────────────
-- Accounts are created through Supabase Auth, then linked here. For each flat:
--   1. Authentication → Users → Add user
--        email:    b-1204@triton.invalid      (flat number, lowercased)
--        password: the flat's starting PIN
--        tick "Auto Confirm User"
--   2. Run, with that user's UUID:
--        insert into public.members (auth_id, login, name, unit, role)
--        values ('<uuid>', 'B-1204', 'Kanika Mehra', 'B-1204', 'resident');
--
-- Committee logins work the same way with role 'committee' and unit null:
--        insert into public.members (auth_id, login, name, unit, role)
--        values ('<uuid>', 'desk.manager', 'Clubhouse Manager', null, 'committee');
--
-- For 300 flats, do it in bulk: export the flat list as CSV and use the
-- Supabase Admin API (service_role key, from a script on your own machine —
-- never in the app) to create users, then one insert per member row.
