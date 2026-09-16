-- =====================================================================
-- CalBlue platform — schema v0.3 (draft, for review)
--
-- Target: Postgres 15+ / Supabase.  Everything here is portable Postgres
-- except the references to `auth.users` and `auth.uid()` / `auth.jwt()`.
--
-- Read alongside docs/design/DESIGN.md. Nothing here has been applied to a
-- database yet; this is the contract we are agreeing before writing code.
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;
-- Supabase may already have citext in its extensions schema. This setup path
-- applies only inside the generated migration transaction; helpers below use
-- their own fixed empty search_path and fully qualified application objects.
set local search_path = public, extensions;

-- ---------------------------------------------------------------------
-- 0. Conventions
--   * every PK is a uuid, every table has created_at / updated_at
--   * status columns are text + CHECK, not enum types, so adding a state
--     is an ordinary migration rather than an ALTER TYPE dance
--   * money is numeric(10,2); it is exact, and the client formats it
--   * all instants are timestamptz (UTC); the *local* calendar date that
--     matters for billing is stored separately (see games.game_date)
-- Issue #25 extraction corrections are intentional: defer the players/clubs
-- FK until both tables exist; complete mutable timestamps; derive game dates
-- from the venue timezone; enforce one scope per role grant; serialize slot
-- transitions and keep internal helpers/client table access closed by default.
-- Core is installed atomically once. Later policy migrations must explicitly
-- grant the minimum client privileges; creating a policy alone grants nothing.
-- ---------------------------------------------------------------------

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;


-- =====================================================================
-- 1. IDENTITY & ACCESS
-- =====================================================================

-- One row per login. Created automatically on sign-up.
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         citext not null unique,
  display_name  text   not null default '',
  phone         text,
  -- Roles are additive: the same person is routinely a player, a coach and
  -- the point of contact for one tournament. Club-wide roles live here;
  -- roles that apply to only one competition or team live in role_grants.
  roles         text[] not null default '{}'
                check (roles <@ array['player','coach','referee','treasurer',
                                      'admin','developer']),
  locale        text   not null default 'en',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Mirror profiles.roles into the JWT so RLS can read them from the token
-- instead of re-querying profiles (which would make profiles policies
-- recursive). NOTE: the claim only changes when the token is refreshed —
-- after a promotion, the user must re-login or refresh.
create or replace function public.sync_role_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.roles is distinct from old.roles then
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                               || jsonb_build_object('roles', to_jsonb(new.roles))
     where id = new.id;
  end if;
  return new;
end $$;

create trigger profiles_sync_roles after insert or update of roles on public.profiles
  for each row execute function public.sync_role_claim();


-- A person inside the club. Deliberately separate from `profiles`, but
-- **at most one identity per account** (see the unique index below):
--   * an account never has two identities, so nothing in the UI ever asks
--     "which of your identities is playing today?"
--   * an identity may exist with NO account at all — a drop-in guest, a
--     visiting player, or a name imported from the old roster sheet — and
--     be claimed later with claim_code
--   * a child is their own identity with no account, pointed at a parent by
--     guardian_account_id. The parent therefore still has exactly one
--     identity (their own) while acting for, and paying for, the children.
create table public.players (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid references public.profiles(id) on delete set null,
  guardian_account_id     uuid references public.profiles(id) on delete set null,
  display_name            text not null,
  legal_name              text,
  date_of_birth           date,
  default_positions       text[] not null default '{}',   -- '{CM,CF}'
  preferred_number        int check (preferred_number between 0 and 99),
  jersey_size             text,
  photo_url               text,
  home_club_id            uuid,  -- FK added below, after clubs exists
  emergency_contact_name  text,
  emergency_contact_phone text,
  medical_notes           text,                           -- restricted, see RLS
  verification_status     text not null default 'pending'
                          check (verification_status in ('pending','verified','rejected')),
  verification_note       text,
  is_public               boolean not null default false, -- opt-in public roster
  claim_code              text unique,                    -- for unclaimed identities
  claimed_at              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Who receives this person's charges: themselves, or their guardian if
  -- they have no login of their own. coalesce of two columns is immutable,
  -- so this can be stored and indexed.
  payer_account_id        uuid generated always as
                          (coalesce(account_id, guardian_account_id)) stored
  -- "a minor must have a guardian" is enforced in the application, not here:
  -- date_of_birth is optional and current_date is not immutable.
);
-- at most one identity per account (many NULLs are allowed: guests)
create unique index players_one_per_account on public.players(account_id)
  where account_id is not null;
create index players_guardian  on public.players(guardian_account_id);
create index players_payer     on public.players(payer_account_id);
create index players_public    on public.players(is_public)
  where is_public and verification_status = 'verified';
create trigger players_touch before update on public.players
  for each row execute function public.touch_updated_at();


-- =====================================================================
-- 2. EVENTS & SCHEDULE
-- =====================================================================

create table public.venues (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  map_url     text,
  surface     text check (surface in ('grass','turf','indoor','other')),
  timezone    text not null default 'America/Los_Angeles',   -- IANA
  notes       text,                                          -- parking, gate code
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger venues_touch before update on public.venues
  for each row execute function public.touch_updated_at();


-- An organisation. CalBlue is one row (is_us); every opponent and every
-- visiting side in a tournament we host is another. Cheap now, and it is what
-- lets section 9 exist at all without rewriting the fixture list.
create table public.clubs (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  short_name     text,
  crest_url      text,
  city           text,
  contact_name   text,
  contact_email  citext,
  contact_phone  text,
  is_us          boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index clubs_only_one_us on public.clubs(is_us) where is_us;
create trigger clubs_touch before update on public.clubs
  for each row execute function public.touch_updated_at();

alter table public.players add constraint players_home_club_id_fkey
  foreign key (home_club_id) references public.clubs(id) on delete set null;

-- CalBlue currently fields one squad; this exists so that adding a B team, a
-- veterans side, or a visiting club's team is a row rather than a migration.
create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references public.clubs(id) on delete restrict,
  name        text not null,
  short_name  text,
  age_group   text,
  is_default  boolean not null default false,   -- our primary squad
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index teams_by_club on public.teams(club_id);
create unique index teams_one_default on public.teams(is_default) where is_default;
create trigger teams_touch before update on public.teams
  for each row execute function public.touch_updated_at();


create table public.competitions (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,                       -- 'Kylin Cup'
  kind                   text not null
                         check (kind in ('league','tournament','cup','friendly_series')),
  season_label           text,                                -- '2026 Spring'
  organiser              text,                                -- 'UPSL', 'NCCSF'
  external_url           text,
  start_date             date,
  end_date               date,
  status                 text not null default 'draft'
                         check (status in ('draft','published','in_progress',
                                           'completed','archived','cancelled')),
  roster_approval        boolean not null default true,       -- admin must approve joiners
  -- 'participant' = we play in it (UPSL, NCCSF).
  -- 'host'        = we run it and other clubs enter (see section 9).
  hosting_mode           text not null default 'participant'
                         check (hosting_mode in ('participant','host')),
  entry_opens_at         timestamptz,
  entry_closes_at        timestamptz,
  entry_fee              numeric(10,2) check (entry_fee >= 0),
  max_teams              int check (max_teams > 0),
  rules_url              text,
  roster_public          boolean not null default false,
  points_win             int not null default 3,
  points_draw            int not null default 1,
  default_fee_per_game   numeric(10,2) check (default_fee_per_game >= 0),
  default_no_show_fee    numeric(10,2) check (default_no_show_fee >= 0),
  description            text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create trigger competitions_touch before update on public.competitions
  for each row execute function public.touch_updated_at();


-- ONE table for every playable event: a league fixture, a tournament match,
-- a friendly, a pickup, a training session. `game_type` distinguishes them.
-- A pickup is exactly `game_type = 'pickup'` — never "competition_id is null",
-- because a friendly can also have no competition.
create table public.games (
  id                      uuid primary key default gen_random_uuid(),
  competition_id          uuid references public.competitions(id) on delete restrict,
  team_id                 uuid references public.teams(id),
  game_type               text not null
                          check (game_type in ('league','tournament','cup',
                                               'friendly','pickup','training')),
  title                   text not null,
  opponent                text,                        -- free text: 'San Ramon FC'
  home_away               text check (home_away in ('home','away','neutral')),
  -- for fixtures we run ourselves, both sides are real rows; for away games
  -- against a club we have not bothered to model, `opponent` is still fine
  home_team_id            uuid references public.teams(id) on delete restrict,
  away_team_id            uuid references public.teams(id) on delete restrict,
  stage_label             text,                        -- 'Group A', 'Semi-final'
  round_number            int,

  -- where
  venue_id                uuid references public.venues(id) on delete restrict,
  field_label             text,                        -- 'Turf 2', 'Field C'
  timezone                text not null default 'America/Los_Angeles',

  -- when
  gather_time             timestamptz,                 -- be at the field by
  start_time              timestamptz not null,        -- kick-off
  end_time                timestamptz,
  game_date               date not null,               -- local date, set by trigger

  -- logistics
  capacity                int check (capacity > 0),    -- null = unlimited
  min_players             int check (min_players > 0),
  waitlist_enabled        boolean not null default true,
  registration_opens_at   timestamptz,
  registration_closes_at  timestamptz,
  kit_color               text,
  notes                   text,

  -- money (null = inherit from competition, then fee_schedules, then 0)
  fee_override            numeric(10,2) check (fee_override >= 0),
  no_show_fee_override    numeric(10,2) check (no_show_fee_override >= 0),

  status                  text not null default 'draft'
                          check (status in ('draft','published','reg_closed',
                                            'completed','locked','cancelled')),
  cancellation_reason     text,
  attendance_locked_at    timestamptz,
  created_by              uuid references public.profiles(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  check (end_time is null or end_time > start_time),
  check (gather_time is null or gather_time <= start_time),
  check (registration_closes_at is null or registration_closes_at <= start_time),
  -- a pickup or training session never belongs to a competition;
  -- a league/tournament/cup fixture always does
  check ((game_type in ('pickup','training')) = (competition_id is null)
         or game_type = 'friendly')
);
create index games_by_date   on public.games(game_date);
create index games_by_comp   on public.games(competition_id);
create index games_published on public.games(status, start_time)
  where status in ('published','reg_closed');

create or replace function public.set_game_date() returns trigger
language plpgsql security definer set search_path = '' as $$
declare venue_timezone text;
begin
  -- A named venue is authoritative; venue-less games use their own timezone.
  -- Run on every write so a direct game_date assignment cannot bypass derivation.
  if new.venue_id is not null then
    select timezone into venue_timezone from public.venues where id = new.venue_id;
    if not found then
      raise exception 'venue_not_found' using errcode = '23503';
    end if;
    new.timezone := venue_timezone;
  end if;
  new.game_date := (new.start_time at time zone new.timezone)::date;
  return new;
end $$;

create trigger games_set_date before insert or update
  on public.games for each row execute function public.set_game_date();
create trigger games_touch before update on public.games
  for each row execute function public.touch_updated_at();


-- Roles that apply to ONE thing rather than the whole club. The organiser of
-- the Kylin Cup is an organiser *of the Kylin Cup* — not a club-wide admin.
-- An account may hold any number of these at once, alongside its club-wide
-- roles in profiles.roles.
create table public.role_grants (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.profiles(id) on delete cascade,
  role           text not null,
  competition_id uuid references public.competitions(id) on delete cascade,
  game_id        uuid references public.games(id) on delete cascade,
  team_id        uuid references public.teams(id) on delete cascade,
  granted_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint role_grant_allowed
    check (role in ('organiser','manager','captain','coach','treasurer')),
  constraint role_grant_scope_required
    check (num_nonnulls(competition_id, game_id, team_id) = 1)
);
create index role_grants_by_account on public.role_grants(account_id);
create index role_grants_by_comp    on public.role_grants(competition_id);
create trigger role_grants_touch before update on public.role_grants
  for each row execute function public.touch_updated_at();


-- =====================================================================
-- 3. PARTICIPATION
-- =====================================================================

-- Season eligibility: being on the roster makes you allowed to register for
-- that competition's games. It does not put you in any particular match.
create table public.competition_registrations (
  id              uuid primary key default gen_random_uuid(),
  competition_id  uuid not null references public.competitions(id) on delete cascade,
  player_id       uuid not null references public.players(id) on delete cascade,
  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected','withdrawn')),
  jersey_number   int check (jersey_number between 0 and 99),
  positions       text[] not null default '{}',
  note            text,
  decided_by      uuid references public.profiles(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (competition_id, player_id)
);
-- two players cannot wear the same number in the same competition
create unique index comp_reg_unique_number
  on public.competition_registrations(competition_id, jersey_number)
  where status = 'approved' and jersey_number is not null;
create trigger comp_reg_touch before update on public.competition_registrations
  for each row execute function public.touch_updated_at();


-- The per-game slot. This one row carries intent (status), identity for the
-- match (number, position) and outcome (attendance) — and it is the only
-- input to billing.
create table public.game_registrations (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid not null references public.games(id) on delete cascade,
  player_id      uuid not null references public.players(id) on delete restrict,

  status         text not null default 'registered'
                 check (status in ('registered','waitlisted','cancelled')),
  participation  text not null default 'player'
                 check (participation in ('player','keeper','coach','volunteer')),

  jersey_number  int check (jersey_number between 0 and 99),
  positions      text[] not null default '{}',

  attendance     text not null default 'unknown'
                 check (attendance in ('unknown','present','absent','excused')),
  checked_in_at  timestamptz,
  checked_in_by  uuid references public.profiles(id),

  registered_by  uuid references public.profiles(id),   -- self, guardian or admin
  registered_at  timestamptz not null default now(),
  cancelled_at   timestamptz,
  late_cancel    boolean not null default false,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (game_id, player_id),                           -- one slot per person
  check (attendance = 'unknown' or status <> 'waitlisted')
);
create index greg_by_game   on public.game_registrations(game_id)
  where status in ('registered','waitlisted');
create index greg_by_player on public.game_registrations(player_id);
create index greg_waitlist  on public.game_registrations(game_id, registered_at)
  where status = 'waitlisted';
create trigger greg_touch before update on public.game_registrations
  for each row execute function public.touch_updated_at();


-- Capacity is enforced in the database, under a per-game advisory lock, so
-- two people clicking "register" at the same moment cannot both get the last
-- slot. The application catches 'game_full' and offers the waitlist instead.
create or replace function public.enforce_game_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cap int; taken int;
begin
  -- The count must get a fresh snapshot after waiting for the advisory lock.
  -- A REPEATABLE READ snapshot can predate another transaction's committed seat.
  -- Support only this isolation contract; fail closed for other modes.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'registration_requires_read_committed' using errcode = '0A000';
  end if;
  -- Serialize all row transitions, including waitlist cancellations and deletes.
  -- Counting as the trusted function owner avoids undercounting rows hidden by RLS.
  if tg_op = 'DELETE' then
    perform pg_advisory_xact_lock(hashtextextended(old.game_id::text, 0));
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.game_id is distinct from old.game_id
       or new.player_id is distinct from old.player_id then
      raise exception 'registration_identity_is_immutable' using errcode = '23514';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.game_id::text, 0));
  if new.status <> 'registered'
     or new.participation not in ('player','keeper') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Editing a row that already occupies a slot does not take another slot.
    if old.status = 'registered' and old.participation in ('player','keeper') then
      return new;
    end if;
  end if;

  select capacity into cap from public.games where id = new.game_id;
  if cap is null then
    return new;
  end if;

  select count(*) into taken
    from public.game_registrations
   where game_id = new.game_id
     and status = 'registered'
     and participation in ('player','keeper')
     -- The unique(game_id, player_id) constraint prevents another seat for this
     -- player. Excluding it also permits an idempotent INSERT ... ON CONFLICT.
     and player_id <> new.player_id;

  if taken >= cap then
    raise exception 'game_full' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger greg_capacity
  before insert or update or delete on public.game_registrations
  for each row execute function public.enforce_game_capacity();


-- When a counted slot frees up, promote the earliest available player/keeper.
-- Locked candidates are skipped to avoid row-lock/advisory-lock deadlocks with
-- concurrent cancellations; status is rechecked so cancellations cannot be undone.
create or replace function public.promote_from_waitlist(p_game uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare cap int; taken int; promoted uuid; game_status text; queue_enabled boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'registration_requires_read_committed' using errcode = '0A000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_game::text, 0));

  select capacity, status, waitlist_enabled into cap, game_status, queue_enabled
    from public.games where id = p_game;
  if not found or cap is null or not queue_enabled
     or game_status not in ('published','reg_closed') then
    return null;
  end if;

  select count(*) into taken
    from public.game_registrations
   where game_id = p_game and status = 'registered'
     and participation in ('player','keeper');

  if taken >= cap then
    return null;
  end if;

  select id into promoted from public.game_registrations
   where game_id = p_game and status = 'waitlisted'
     and participation in ('player','keeper')
   order by registered_at, id
   limit 1 for update skip locked;

  if promoted is not null then
    update public.game_registrations set status = 'registered'
     where id = promoted and game_id = p_game and status = 'waitlisted'
       and participation in ('player','keeper')
    returning id into promoted;
  end if;

  return promoted;   -- caller (or a notification trigger) tells the player
end $$;

create or replace function public.on_slot_freed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'registered' and old.participation in ('player','keeper') then
    if tg_op = 'DELETE' then
      perform public.promote_from_waitlist(old.game_id);
    elsif new.status <> 'registered' or new.participation not in ('player','keeper') then
      perform public.promote_from_waitlist(old.game_id);
    end if;
  end if;
  return null;
end $$;

create trigger greg_promote after update or delete on public.game_registrations
  for each row execute function public.on_slot_freed();

-- Core must be safe to install before issue #27's policy/grant design exists.
-- RLS without policies denies row access; revoke table privileges too because
-- operations such as TRUNCATE are not controlled by RLS. Internal trigger
-- functions run under their owner where needed, not as public RPC endpoints.
alter table public.profiles enable row level security;
alter table public.players enable row level security;
alter table public.venues enable row level security;
alter table public.clubs enable row level security;
alter table public.teams enable row level security;
alter table public.competitions enable row level security;
alter table public.games enable row level security;
alter table public.role_grants enable row level security;
alter table public.competition_registrations enable row level security;
alter table public.game_registrations enable row level security;

revoke all on table public.profiles, public.players, public.venues, public.clubs,
  public.teams, public.competitions, public.games, public.role_grants,
  public.competition_registrations, public.game_registrations
  from public, anon, authenticated;

revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.sync_role_claim() from public, anon, authenticated;
revoke all on function public.set_game_date() from public, anon, authenticated;
revoke all on function public.enforce_game_capacity() from public, anon, authenticated;
revoke all on function public.promote_from_waitlist(uuid) from public, anon, authenticated;
revoke all on function public.on_slot_freed() from public, anon, authenticated;


-- =====================================================================
-- 4. MONEY
-- =====================================================================

-- Issue #26 corrects the draft's incomplete immutability and locking rules.
-- This phase is intentionally deny-by-default: trusted SQL can exercise the
-- foundation, but no browser policy, money RPC grant or entry-fee UI exists yet.
-- A club-wide transaction lock favors correctness over write throughput. The
-- BEFORE STATEMENT triggers below acquire it before ordinary DML row locks;
-- finalization additionally takes the existing per-game registration lock.
-- Explicit owner locks/disabled triggers/DDL remain privileged maintenance and
-- are outside this protocol. Two-session concurrency still needs runtime tests.
-- An owner's direct call to 0001's promote_from_waitlist takes the per-game lock
-- first and can deadlock against this ordering; maintenance must retry an aborted
-- transaction. This phase does not rewrite that previously released helper.
create or replace function public.lock_billing() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'billing_requires_read_committed' using errcode = '0A000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('calblue:billing:v1', 0));
end $$;

create or replace function public.lock_billing_statement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_billing();
  if tg_op = 'TRUNCATE' then
    raise exception 'billing_truncate_forbidden' using errcode = '23514';
  end if;
  return null;
end $$;

create table public.fee_schedules (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  competition_id  uuid references public.competitions(id) on delete cascade,
  game_type       text check (game_type in ('league','tournament','cup',
                                            'friendly','pickup','training')),
  amount          numeric(10,2) not null check (amount >= 0 and amount <> 'NaN'::numeric),
  effective_from  date not null default current_date,
  effective_to    date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (competition_id is not null or game_type is not null),
  check (effective_to is null or effective_to >= effective_from)
);
create trigger fee_schedules_touch before update on public.fee_schedules
  for each row execute function public.touch_updated_at();


create table public.billing_periods (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,                 -- '2026-Q1'
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open'
              check (status in ('open','preview','closed')),
  closed_at   timestamptz,
  closed_by   uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date),
  check ((status = 'closed') = (closed_at is not null)),
  check (status = 'closed' or closed_by is null)
);
-- periods must not overlap
alter table public.billing_periods
  add constraint billing_periods_no_overlap
  exclude using gist (daterange(start_date, end_date, '[]') with &&);
create trigger billing_periods_touch before update on public.billing_periods
  for each row execute function public.touch_updated_at();

-- The latest closed end date also seals earlier gaps: a newly backdated entry
-- in a gap would otherwise change an already-issued opening balance.
create or replace function public.require_open_billing_date(p_date date, p_period uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare cutoff date; period_row public.billing_periods;
begin
  perform public.lock_billing();
  if p_date is null then
    raise exception 'billing_date_required' using errcode = '23514';
  end if;
  select max(end_date) into cutoff from public.billing_periods where status = 'closed';
  if p_date <= cutoff then
    raise exception 'billing_history_closed' using errcode = '23514';
  end if;
  if p_period is not null then
    select * into period_row from public.billing_periods where id = p_period;
    if not found then
      raise exception 'billing_period_not_found' using errcode = '23503';
    end if;
    if period_row.status = 'closed' then
      raise exception 'billing_period_is_closed' using errcode = '23514';
    end if;
    if p_date not between period_row.start_date and period_row.end_date then
      raise exception 'billing_period_date_mismatch' using errcode = '23514';
    end if;
  end if;
end $$;


-- Immutable line items. A charge is written once, with the fee that applied
-- on the day — so changing a fee schedule next season never rewrites history.
-- Mistakes are voided (and re-issued), never edited or deleted.
create table public.charges (
  id                uuid primary key default gen_random_uuid(),
  -- nullable, because a tournament entry fee is owed by a club, not a person
  player_id         uuid references public.players(id) on delete restrict,
  account_id        uuid references public.profiles(id) on delete restrict, -- payer at the time
  game_id           uuid references public.games(id) on delete restrict,
  competition_id    uuid references public.competitions(id) on delete restrict,
  billing_period_id uuid references public.billing_periods(id) on delete restrict,
  kind              text not null
                    check (kind in ('game_fee','season_dues','no_show','late_cancel',
                                    'equipment','adjustment','credit','entry_fee')),
  description       text not null,
  amount            numeric(10,2) not null check (amount <> 0 and amount <> 'NaN'::numeric), -- negative = credit
  charge_date       date not null,
  source            text not null default 'auto' check (source in ('auto','manual')),
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  voided_at         timestamptz,
  voided_by         uuid references public.profiles(id),
  void_reason       text,
  -- Exactly one subject. The entry FK and validation arrive with section 9;
  -- this forward-compatible column is not an authorized entry-fee workflow.
  entry_id          uuid,
  check (num_nonnulls(player_id, entry_id) = 1),
  check ((voided_at is null and voided_by is null and void_reason is null)
         or (voided_at is not null and nullif(btrim(void_reason), '') is not null))
);
-- makes attendance finalisation idempotent: re-running never double-charges
create unique index charges_auto_once on public.charges(game_id, player_id, kind)
  where source = 'auto' and voided_at is null and game_id is not null;
create index charges_by_player  on public.charges(player_id, charge_date);
create index charges_by_entry   on public.charges(entry_id);
create index charges_by_account on public.charges(account_id, charge_date);
create index charges_by_period  on public.charges(billing_period_id);

create or replace function public.charges_are_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'charges_are_immutable' using errcode = '23514';
  end if;
  perform public.require_open_billing_date(new.charge_date, new.billing_period_id);
  if tg_op = 'INSERT' then
    if new.voided_at is not null or new.voided_by is not null or new.void_reason is not null then
      raise exception 'charge_void_requires_update' using errcode = '23514';
    end if;
    return new;
  end if;
  -- Compare all present/future columns except the explicitly permitted fields.
  if (to_jsonb(new) - array['updated_at','billing_period_id','voided_at','voided_by','void_reason'])
     is distinct from
     (to_jsonb(old) - array['updated_at','billing_period_id','voided_at','voided_by','void_reason']) then
    raise exception 'charges_are_immutable' using errcode = '23514';
  end if;
  if old.billing_period_id is not null
     and new.billing_period_id is distinct from old.billing_period_id then
    raise exception 'billing_period_assignment_immutable' using errcode = '23514';
  end if;
  if old.voided_at is not null then
    if (new.voided_at, new.voided_by, new.void_reason)
       is distinct from (old.voided_at, old.voided_by, old.void_reason) then
      raise exception 'charge_void_is_final' using errcode = '23514';
    end if;
  elsif new.voided_at is not null then
    if nullif(btrim(new.void_reason), '') is null then
      raise exception 'charge_void_reason_required' using errcode = '23514';
    end if;
  elsif new.voided_by is not null or new.void_reason is not null then
    raise exception 'charge_void_reason_required' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger charges_immutable before update or delete on public.charges
  for each row execute function public.charges_are_immutable();
create trigger charges_validate_insert before insert on public.charges
  for each row execute function public.charges_are_immutable();
create trigger charges_touch before update on public.charges
  for each row execute function public.touch_updated_at();


create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.profiles(id) on delete restrict,
  player_id         uuid references public.players(id) on delete restrict,  -- optional allocation
  billing_period_id uuid references public.billing_periods(id) on delete restrict,
  amount            numeric(10,2) not null check (amount <> 0 and amount <> 'NaN'::numeric), -- negative = refund
  method            text not null default 'other'
                    check (method in ('venmo','zelle','cash','check','card','other')),
  payment_date      date not null default current_date,
  external_ref      text,                       -- Venmo note, check number
  recorded_by       uuid references public.profiles(id),
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index payments_by_account on public.payments(account_id, payment_date);
create index payments_by_period  on public.payments(billing_period_id);

-- Payments are facts too: corrections use a refund/replacement, not a rewrite.
create or replace function public.payments_are_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payments_are_immutable' using errcode = '23514';
  end if;
  perform public.require_open_billing_date(new.payment_date, new.billing_period_id);
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array['updated_at','billing_period_id'])
       is distinct from (to_jsonb(old) - array['updated_at','billing_period_id']) then
      raise exception 'payments_are_immutable' using errcode = '23514';
    end if;
    if old.billing_period_id is not null
       and new.billing_period_id is distinct from old.billing_period_id then
      raise exception 'billing_period_assignment_immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger payments_immutable before insert or update or delete on public.payments
  for each row execute function public.payments_are_immutable();
create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();


-- Frozen snapshots, written when a period is closed. Two grains, because
-- attendance is a property of a player and money is a property of a payer.
create table public.period_player_summaries (
  id                  uuid primary key default gen_random_uuid(),
  billing_period_id   uuid not null references public.billing_periods(id) on delete restrict,
  player_id           uuid not null references public.players(id),
  account_id          uuid references public.profiles(id),
  games_attended      int not null default 0,
  attended_league     int not null default 0,
  attended_tournament int not null default 0,
  attended_pickup     int not null default 0,
  attended_other      int not null default 0,
  no_shows            int not null default 0,
  late_cancels        int not null default 0,
  charges_total       numeric(10,2) not null default 0,
  created_at          timestamptz not null default now(),
  unique (billing_period_id, player_id)
);

create table public.period_account_summaries (
  id                uuid primary key default gen_random_uuid(),
  billing_period_id uuid not null references public.billing_periods(id) on delete restrict,
  account_id        uuid not null references public.profiles(id),
  opening_balance   numeric(10,2) not null default 0,
  charges_total     numeric(10,2) not null default 0,
  payments_total    numeric(10,2) not null default 0,
  closing_balance   numeric(10,2) not null default 0,
  created_at        timestamptz not null default now(),
  unique (billing_period_id, account_id)
);


create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles(id),
  action     text not null,                   -- 'insert' | 'update' | 'delete' | 'break_glass'
  table_name text not null,
  row_id     text,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);
create index audit_by_table on public.audit_log(table_name, created_at desc);

create or replace function public.guard_billing_period() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_billing();
  if tg_op <> 'INSERT' and old.status = 'closed' then
    raise exception 'billing_period_is_closed' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'closed' then
      raise exception 'billing_period_cannot_start_closed' using errcode = '23514';
    end if;
  else
    if (new.id, new.start_date, new.end_date, new.created_at)
       is distinct from (old.id, old.start_date, old.end_date, old.created_at) then
      raise exception 'billing_period_dates_immutable' using errcode = '23514';
    end if;
  end if;
  perform public.require_open_billing_date(new.start_date, null);
  if new.status = 'closed' then
    -- All ordinary status transitions, even direct trusted SQL updates, run
    -- exactly the same closure checks and snapshot writer. No client-settable
    -- session flag is accepted as evidence that closure was authorized.
    perform public.write_billing_period_summaries(old.id);
    new.closed_at := now();
    new.closed_by := auth.uid();
  elsif new.closed_at is not null or new.closed_by is not null then
    raise exception 'billing_period_not_closed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger billing_periods_guard before insert or update or delete on public.billing_periods
  for each row execute function public.guard_billing_period();

create or replace function public.freeze_billing_history() returns trigger
language plpgsql security definer set search_path = '' as $$
declare period_status text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'billing_history_is_immutable' using errcode = '23514';
  end if;
  select status into period_status from public.billing_periods where id = new.billing_period_id;
  if not found then
    raise exception 'billing_period_not_found' using errcode = '23503';
  end if;
  if period_status = 'closed' then
    raise exception 'billing_period_is_closed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger player_summaries_frozen before insert or update or delete on public.period_player_summaries
  for each row execute function public.freeze_billing_history();
create trigger account_summaries_frozen before insert or update or delete on public.period_account_summaries
  for each row execute function public.freeze_billing_history();
create trigger audit_log_frozen before update or delete on public.audit_log
  for each row execute function public.freeze_billing_history();

-- These add guards rather than redefining any function released in 0001.
create or replace function public.guard_billed_game() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op <> 'INSERT' and (old.status = 'locked' or old.attendance_locked_at is not null) then
    if tg_op = 'DELETE' then
      raise exception 'game_attendance_is_locked' using errcode = '23514';
    end if;
    if (new.id, new.competition_id, new.game_type, new.start_time, new.timezone,
        new.venue_id, new.game_date, new.fee_override, new.no_show_fee_override,
        new.status, new.attendance_locked_at)
       is distinct from
       (old.id, old.competition_id, old.game_type, old.start_time, old.timezone,
        old.venue_id, old.game_date, old.fee_override, old.no_show_fee_override,
        old.status, old.attendance_locked_at) then
      raise exception 'game_attendance_is_locked' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      perform public.require_open_billing_date(old.game_date, null);
    end if;
    return old;
  end if;
  if new.status = 'locked' and (tg_op = 'INSERT' or old.status <> 'locked') then
    if tg_op = 'INSERT' then
      raise exception 'game_cannot_start_locked' using errcode = '23514';
    end if;
    if old.status <> 'completed' then
      raise exception 'game_must_be_completed' using errcode = '23514';
    end if;
    if (new.id, new.competition_id, new.game_type, new.start_time, new.timezone,
        new.venue_id, new.game_date, new.fee_override, new.no_show_fee_override)
       is distinct from
       (old.id, old.competition_id, old.game_type, old.start_time, old.timezone,
        old.venue_id, old.game_date, old.fee_override, old.no_show_fee_override) then
      raise exception 'game_finalisation_cannot_change_facts' using errcode = '23514';
    end if;
    perform public.write_game_attendance_charges(old.id);
    new.attendance_locked_at := now();
  end if;
  if (new.status = 'locked') <> (new.attendance_locked_at is not null) then
    raise exception 'game_attendance_lock_mismatch' using errcode = '23514';
  end if;
  -- Drafts deliberately do not block period closure. They cannot subsequently
  -- become published/completed historical games inside the sealed date range.
  if new.status <> 'draft' then
    if tg_op = 'INSERT' or old.status <> 'locked' then
      perform public.require_open_billing_date(new.game_date, null);
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status not in ('draft','locked') then
    perform public.require_open_billing_date(old.game_date, null);
  end if;
  return new;
end $$;
-- Alphabetical ordering runs this after 0001's games_set_date trigger.
create trigger games_z_billing_guard before insert or update or delete on public.games
  for each row execute function public.guard_billed_game();

create or replace function public.guard_billed_registration() returns trigger
language plpgsql security definer set search_path = '' as $$
declare game_row public.games; target_game uuid;
begin
  target_game := case when tg_op = 'DELETE' then old.game_id else new.game_id end;
  select * into game_row from public.games where id = target_game;
  if not found then
    -- A parent-game DELETE may already hide its row in an FK cascade; the
    -- game guard checked that deletion before this child operation began.
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if game_row.status = 'locked' or game_row.attendance_locked_at is not null then
    if tg_op <> 'UPDATE' then
      raise exception 'game_attendance_is_locked' using errcode = '23514';
    end if;
    if (new.game_id, new.player_id, new.status, new.participation,
        new.attendance, new.checked_in_at, new.checked_in_by, new.late_cancel)
       is distinct from
       (old.game_id, old.player_id, old.status, old.participation,
        old.attendance, old.checked_in_at, old.checked_in_by, old.late_cancel) then
      raise exception 'game_attendance_is_locked' using errcode = '23514';
    end if;
  elsif game_row.status <> 'draft' then
    perform public.require_open_billing_date(game_row.game_date, null);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger greg_billing_guard before insert or update or delete on public.game_registrations
  for each row execute function public.guard_billed_registration();

create trigger fee_schedules_billing_lock before insert or update or delete or truncate on public.fee_schedules
  for each statement execute function public.lock_billing_statement();
create trigger billing_periods_billing_lock before insert or update or delete or truncate on public.billing_periods
  for each statement execute function public.lock_billing_statement();
create trigger charges_billing_lock before insert or update or delete or truncate on public.charges
  for each statement execute function public.lock_billing_statement();
create trigger payments_billing_lock before insert or update or delete or truncate on public.payments
  for each statement execute function public.lock_billing_statement();
create trigger player_summaries_billing_lock before insert or update or delete or truncate on public.period_player_summaries
  for each statement execute function public.lock_billing_statement();
create trigger account_summaries_billing_lock before insert or update or delete or truncate on public.period_account_summaries
  for each statement execute function public.lock_billing_statement();
create trigger audit_log_billing_lock before insert or update or delete or truncate on public.audit_log
  for each statement execute function public.lock_billing_statement();
create trigger games_billing_lock before insert or update or delete or truncate on public.games
  for each statement execute function public.lock_billing_statement();
create trigger greg_billing_lock before insert or update or delete or truncate on public.game_registrations
  for each statement execute function public.lock_billing_statement();
create trigger players_billing_lock before insert or update or delete or truncate on public.players
  for each statement execute function public.lock_billing_statement();
create trigger competitions_billing_lock before insert or update or delete or truncate on public.competitions
  for each statement execute function public.lock_billing_statement();
create trigger profiles_billing_lock before insert or update or delete or truncate on public.profiles
  for each statement execute function public.lock_billing_statement();


-- =====================================================================
-- 5. BILLING FUNCTIONS AND INTERNAL WRITERS
-- =====================================================================

-- 5.1 What does this game cost a player? One definition, used by the
--     registration screen, the charge writer and the CSV export alike.
create or replace function public.resolve_game_fee(p_game uuid)
returns numeric
language sql stable set search_path = '' as $$
  select coalesce(
    g.fee_override,
    c.default_fee_per_game,
    (select fs.amount
       from public.fee_schedules fs
      where (fs.competition_id = g.competition_id
             or (fs.competition_id is null and fs.game_type = g.game_type))
        and (fs.game_type is null or fs.game_type = g.game_type)
        and fs.effective_from <= g.game_date
        and (fs.effective_to is null or fs.effective_to >= g.game_date)
      order by (fs.competition_id is not null) desc, fs.effective_from desc,
               fs.created_at desc, fs.id
      limit 1),
    0)
  from public.games g
  left join public.competitions c on c.id = g.competition_id
  where g.id = p_game
$$;

create or replace function public.resolve_no_show_fee(p_game uuid)
returns numeric
language sql stable set search_path = '' as $$
  select coalesce(g.no_show_fee_override, c.default_no_show_fee, 0)
  from public.games g
  left join public.competitions c on c.id = g.competition_id
  where g.id = p_game
$$;


-- 5.2 The game guard calls this private writer before moving completed→locked.
--     Direct owner status updates therefore cannot silently skip billing.
create or replace function public.write_game_attendance_charges(p_game uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_fee numeric; v_no_show numeric; v_game public.games;
begin
  perform public.lock_billing();
  perform pg_advisory_xact_lock(hashtextextended(p_game::text, 0));
  select * into v_game from public.games where id = p_game for update;
  if not found then
    raise exception 'game_not_found' using errcode = '23503';
  end if;
  if v_game.status in ('cancelled','locked') then
    return;
  end if;
  if v_game.status <> 'completed' then
    raise exception 'game_must_be_completed' using errcode = '23514';
  end if;
  perform public.require_open_billing_date(v_game.game_date, null);

  update public.game_registrations
     set attendance = 'absent'
   where game_id = p_game
     and status = 'registered'
     and participation in ('player','keeper')
     and attendance = 'unknown';

  v_fee     := public.resolve_game_fee(p_game);
  v_no_show := public.resolve_no_show_fee(p_game);

  -- the game fee, for everyone who actually played
  insert into public.charges (player_id, account_id, game_id, competition_id,
                              kind, description, amount, charge_date, source)
  select gr.player_id, p.payer_account_id, p_game, v_game.competition_id,
         'game_fee', v_game.title, v_fee, v_game.game_date, 'auto'
    from public.game_registrations gr
    join public.players p on p.id = gr.player_id
   where gr.game_id = p_game
     and gr.attendance = 'present'
     and gr.status = 'registered'
     and gr.participation in ('player','keeper')
     and v_fee > 0
  on conflict (game_id, player_id, kind)
    where source = 'auto' and voided_at is null and game_id is not null
    do nothing;

  -- the no-show fee, if the club charges one
  insert into public.charges (player_id, account_id, game_id, competition_id,
                              kind, description, amount, charge_date, source)
  select gr.player_id, p.payer_account_id, p_game, v_game.competition_id,
         'no_show', 'No-show: ' || v_game.title, v_no_show, v_game.game_date, 'auto'
    from public.game_registrations gr
    join public.players p on p.id = gr.player_id
   where gr.game_id = p_game
     and gr.attendance = 'absent'
     and gr.status = 'registered'
     and gr.participation in ('player','keeper')
     and v_no_show > 0
  on conflict (game_id, player_id, kind)
    where source = 'auto' and voided_at is null and game_id is not null
    do nothing;
end $$;

-- Retrying a successful finalization is a no-op, including after its period
-- closes. The private writer and partial unique index are defense in depth.
create or replace function public.finalise_game_attendance(p_game uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare game_status text;
begin
  perform public.lock_billing();
  perform pg_advisory_xact_lock(hashtextextended(p_game::text, 0));
  select status into game_status from public.games where id = p_game for update;
  if not found then
    raise exception 'game_not_found' using errcode = '23503';
  end if;
  if game_status in ('cancelled','locked') then
    return;
  end if;
  if game_status <> 'completed' then
    raise exception 'game_must_be_completed' using errcode = '23514';
  end if;
  update public.games
     set status = 'locked', attendance_locked_at = now()
   where id = p_game;
end $$;


-- 5.3 File every unassigned charge and payment into the period its date
--     falls in. Only touches open periods.
create or replace function public.assign_to_periods()
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_billing();
  update public.charges ch set billing_period_id = p.id
    from public.billing_periods p
   where ch.billing_period_id is null and p.status <> 'closed'
     and ch.charge_date between p.start_date and p.end_date;
  update public.payments pay set billing_period_id = p.id
    from public.billing_periods p
   where pay.billing_period_id is null and p.status <> 'closed'
     and pay.payment_date between p.start_date and p.end_date;
end $$;


-- 5.4 Close the quarter: freeze both snapshots. Refuses if any game in the
--     window still has unfinalised attendance, because that would silently
--     under-bill somebody.
-- Private snapshot writer used by the period guard. The guard, rather than a
-- forgeable GUC or an assumption about the caller, makes every close transition
-- execute these checks. Only the owner may insert snapshots in this phase;
-- future client grants for snapshots must remain SELECT-only.
create or replace function public.write_billing_period_summaries(p_period uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.billing_periods;
begin
  perform public.lock_billing();
  select * into v from public.billing_periods where id = p_period for update;
  if not found then
    raise exception 'billing_period_not_found' using errcode = '23503';
  end if;
  if v.status = 'closed' then
    raise exception 'billing_period_is_closed' using errcode = '23514';
  end if;
  if exists (select 1 from public.billing_periods
              where id <> p_period and start_date < v.start_date and status <> 'closed')
     or exists (select 1 from public.billing_periods
                 where status = 'closed' and end_date >= v.start_date) then
    raise exception 'billing_period_close_out_of_order' using errcode = '23514';
  end if;
  if exists (select 1 from public.period_player_summaries where billing_period_id = p_period)
     or exists (select 1 from public.period_account_summaries where billing_period_id = p_period) then
    raise exception 'billing_period_snapshots_already_exist' using errcode = '23514';
  end if;

  if exists (select 1 from public.games g
              where g.game_date between v.start_date and v.end_date
                and g.status not in ('locked','cancelled','draft')) then
    raise exception 'billing_period_has_unfinalised_games' using errcode = '23514';
  end if;

  perform public.assign_to_periods();

  with att as (
    select gr.player_id,
           count(*) filter (where gr.status = 'registered' and gr.attendance = 'present') as present,
           count(*) filter (where gr.status = 'registered' and gr.attendance = 'present'
                              and g.game_type = 'league') as league,
           count(*) filter (where gr.status = 'registered' and gr.attendance = 'present'
                              and g.game_type in ('tournament','cup')) as tourn,
           count(*) filter (where gr.status = 'registered' and gr.attendance = 'present'
                              and g.game_type = 'pickup') as pickup,
           count(*) filter (where gr.status = 'registered' and gr.attendance = 'present'
                              and g.game_type in ('friendly','training')) as other,
           count(*) filter (where gr.status = 'registered' and gr.attendance = 'absent') as no_shows,
           count(*) filter (where gr.status = 'cancelled' and gr.late_cancel) as late_cancels
      from public.game_registrations gr
      join public.games g on g.id = gr.game_id
     where g.game_date between v.start_date and v.end_date
       -- Drafts are not played obligations. Cancelled games never contribute;
       -- only finalized registered players/keepers count toward attendance.
       and g.status = 'locked'
       and gr.participation in ('player','keeper')
       and (gr.status = 'registered' or (gr.status = 'cancelled' and gr.late_cancel))
     group by gr.player_id
  ), money as (
    select player_id, sum(amount) as total
      from public.charges
     where billing_period_id = p_period and voided_at is null and player_id is not null
     group by player_id
  ), ids as (
    select player_id from att
    union
    select player_id from money
  )
  insert into public.period_player_summaries (
    billing_period_id, player_id, account_id, games_attended,
    attended_league, attended_tournament, attended_pickup, attended_other,
    no_shows, late_cancels, charges_total)
  select p_period, i.player_id, pl.payer_account_id,
         coalesce(a.present, 0), coalesce(a.league, 0), coalesce(a.tourn, 0),
         coalesce(a.pickup, 0), coalesce(a.other, 0), coalesce(a.no_shows, 0),
         coalesce(a.late_cancels, 0), coalesce(m.total, 0)
    from ids i
    join public.players pl on pl.id = i.player_id
    left join att   a on a.player_id = i.player_id
    left join money m on m.player_id = i.player_id;

  insert into public.period_account_summaries (
    billing_period_id, account_id, opening_balance,
    charges_total, payments_total, closing_balance)
  select p_period,
         a.id,
         coalesce(o.opening, 0),
         coalesce(c.total, 0),
         coalesce(pm.total, 0),
         coalesce(o.opening, 0) + coalesce(c.total, 0) - coalesce(pm.total, 0)
    from public.profiles a
    left join lateral (
      select coalesce(sum(ch.amount), 0)
             - coalesce((select sum(p2.amount) from public.payments p2
                          where p2.account_id = a.id and p2.payment_date < v.start_date), 0)
             as opening
        from public.charges ch
       where ch.account_id = a.id and ch.voided_at is null
         and ch.charge_date < v.start_date) o on true
    left join lateral (
      select sum(ch.amount) as total from public.charges ch
       where ch.account_id = a.id and ch.billing_period_id = p_period
         and ch.voided_at is null) c on true
    left join lateral (
      select sum(pay.amount) as total from public.payments pay
       where pay.account_id = a.id and pay.billing_period_id = p_period) pm on true
   where coalesce(o.opening, 0) <> 0
      or coalesce(c.total, 0) <> 0
      or coalesce(pm.total, 0) <> 0;

end $$;

create or replace function public.close_billing_period(p_period uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare period_status text;
begin
  perform public.lock_billing();
  select status into period_status from public.billing_periods where id = p_period for update;
  if not found then
    raise exception 'billing_period_not_found' using errcode = '23503';
  end if;
  if period_status = 'closed' then
    raise exception 'billing_period_is_closed' using errcode = '23514';
  end if;
  -- The guard writes both snapshots before this state transition completes.
  update public.billing_periods set status = 'closed' where id = p_period;
end $$;


-- =====================================================================
-- 6. VIEWS the app reads
-- =====================================================================

-- Live balance for an account, over all time. This is the number that
-- actually matters; the period snapshots are the paper trail behind it.
create or replace view public.v_account_balance with (security_invoker = true) as
select a.id as account_id,
       coalesce(c.total, 0) as charges_total,
       coalesce(p.total, 0) as payments_total,
       coalesce(c.total, 0) - coalesce(p.total, 0) as balance
  from public.profiles a
  left join lateral (select sum(amount) total from public.charges
                      where account_id = a.id and voided_at is null) c on true
  left join lateral (select sum(amount) total from public.payments
                      where account_id = a.id) p on true;

-- One statement line per charge or payment, for the "why do I owe this?" screen.
create or replace view public.v_account_ledger with (security_invoker = true) as
select account_id, charge_date as entry_date, kind as entry_type,
       description, amount, 'charge'::text as direction, id as source_id
  from public.charges where voided_at is null
union all
select account_id, payment_date, method,
       coalesce(note, 'Payment received'), -amount, 'payment', id
  from public.payments;

-- Public roster: opt-in only, verified only.
create or replace view public.v_public_roster with (security_invoker = true) as
select p.id, p.display_name, p.preferred_number, p.default_positions, p.photo_url
  from public.players p
 where p.is_public and p.verification_status = 'verified';


-- =====================================================================
-- 7. ROW-LEVEL SECURITY
--   Roles come from the JWT (synced from profiles.roles above) so that
--   policies never re-query profiles — that would recurse.
-- =====================================================================

create or replace function public.app_roles() returns text[]
language sql stable as $$
  select case
    when auth.jwt() -> 'app_metadata' ? 'roles'
      then array(select jsonb_array_elements_text(
                          auth.jwt() -> 'app_metadata' -> 'roles'))
    else array[]::text[]
  end
$$;

create or replace function public.has_role(r text) returns boolean
language sql stable as $$ select r = any(public.app_roles()) $$;

create or replace function public.is_admin() returns boolean
language sql stable as $$ select public.has_role('admin') $$;

-- Holding a scoped role over one competition, game or team. This is what
-- makes somebody the point of contact for a single tournament without
-- giving them any authority over the rest of the club.
create or replace function public.has_grant_on_competition(c uuid, roles text[])
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.role_grants g
                  where g.account_id = auth.uid()
                    and g.competition_id = c
                    and g.role = any(roles))
$$;

create or replace function public.owns_player(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.players pl
                  where pl.id = p
                    and (pl.account_id = auth.uid()
                         or pl.guardian_account_id = auth.uid()))
$$;

create or replace function public.manages_game(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.role_grants rg
     where rg.account_id = auth.uid()
       and rg.role in ('organiser','manager','captain','coach')
       and (rg.game_id = g
            or rg.competition_id = (select competition_id
                                      from public.games where id = g)
            or rg.team_id = (select team_id from public.games where id = g)))
$$;

alter table public.profiles                  enable row level security;
alter table public.players                   enable row level security;
alter table public.role_grants               enable row level security;
alter table public.clubs                     enable row level security;
alter table public.venues                    enable row level security;
alter table public.teams                     enable row level security;
alter table public.competitions              enable row level security;
alter table public.games                     enable row level security;
alter table public.competition_registrations enable row level security;
alter table public.game_registrations        enable row level security;
alter table public.fee_schedules             enable row level security;
alter table public.billing_periods           enable row level security;
alter table public.charges                   enable row level security;
alter table public.payments                  enable row level security;
alter table public.period_player_summaries   enable row level security;
alter table public.period_account_summaries  enable row level security;
alter table public.audit_log                 enable row level security;

-- profiles: yourself, or an admin
create policy profiles_self_read on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy profiles_self_write on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
-- a user may not promote themselves; only an admin may change `role`
create or replace function public.guard_role_change() returns trigger
language plpgsql as $$
begin
  if new.roles is distinct from old.roles and not public.is_admin() then
    raise exception 'only an admin may change roles';
  end if;
  return new;
end $$;
create trigger profiles_guard_role before update on public.profiles
  for each row execute function public.guard_role_change();

-- players: your own identities, plus the opt-in public roster
create policy players_read on public.players for select
  using (public.is_admin()
         or account_id = auth.uid()
         or guardian_account_id = auth.uid()
         or (is_public and verification_status = 'verified'));
create policy players_insert on public.players for insert
  with check (public.is_admin() or account_id = auth.uid());
create policy players_update on public.players for update
  using (public.is_admin() or account_id = auth.uid()
         or guardian_account_id = auth.uid());
-- verification_status is admin-only, enforced by trigger rather than policy
create or replace function public.guard_verification() returns trigger
language plpgsql as $$
begin
  if new.verification_status is distinct from old.verification_status
     and not public.is_admin() then
    raise exception 'only an admin may verify a player';
  end if;
  return new;
end $$;
create trigger players_guard_verification before update on public.players
  for each row execute function public.guard_verification();

-- schedule: published events are world-readable; drafts are staff-only
create policy games_read on public.games for select
  using (status <> 'draft' or public.is_admin() or public.manages_game(id));
create policy games_write on public.games for all
  using (public.is_admin() or public.manages_game(id))
  with check (public.is_admin() or public.manages_game(id));

create policy competitions_read on public.competitions for select
  using (status <> 'draft' or public.is_admin());
create policy competitions_write on public.competitions for all
  using (public.is_admin()) with check (public.is_admin());

create policy clubs_read on public.clubs for select using (true);
create policy clubs_write on public.clubs for all
  using (public.is_admin()) with check (public.is_admin());

create policy venues_read on public.venues for select using (true);
create policy venues_write on public.venues for all
  using (public.is_admin()) with check (public.is_admin());

create policy fees_read on public.fee_schedules for select using (true);
create policy fees_write on public.fee_schedules for all
  using (public.is_admin()) with check (public.is_admin());

-- registrations: your own, plus everything on a game you run
create policy greg_read on public.game_registrations for select
  using (public.is_admin() or public.owns_player(player_id)
         or public.manages_game(game_id));
create policy greg_insert on public.game_registrations for insert
  with check (public.is_admin() or public.manages_game(game_id)
              or public.owns_player(player_id));
create policy greg_update on public.game_registrations for update
  using (public.is_admin() or public.manages_game(game_id)
         or public.owns_player(player_id));
-- a player may change their own number/position/status, never their attendance
create or replace function public.guard_attendance() returns trigger
language plpgsql as $$
begin
  if (new.attendance, new.checked_in_at, new.checked_in_by)
     is distinct from (old.attendance, old.checked_in_at, old.checked_in_by)
     and not (public.is_admin() or public.manages_game(new.game_id)) then
    raise exception 'only a captain or an admin may record attendance';
  end if;
  return new;
end $$;
create trigger greg_guard_attendance before update on public.game_registrations
  for each row execute function public.guard_attendance();

create policy creg_read on public.competition_registrations for select
  using (public.is_admin() or public.owns_player(player_id));
create policy creg_insert on public.competition_registrations for insert
  with check (public.is_admin() or public.owns_player(player_id));
create policy creg_update on public.competition_registrations for update
  using (public.is_admin() or public.owns_player(player_id));

-- money: read your own, write nothing
create policy charges_read on public.charges for select
  using (public.is_admin() or account_id = auth.uid()
         or public.owns_player(player_id));
create policy charges_write on public.charges for all
  using (public.is_admin()) with check (public.is_admin());

create policy payments_read on public.payments for select
  using (public.is_admin() or account_id = auth.uid());
create policy payments_write on public.payments for all
  using (public.is_admin()) with check (public.is_admin());

create policy periods_read on public.billing_periods for select
  using (public.is_admin());
create policy periods_write on public.billing_periods for all
  using (public.is_admin()) with check (public.is_admin());

create policy pps_read on public.period_player_summaries for select
  using (public.is_admin() or public.owns_player(player_id));
create policy pas_read on public.period_account_summaries for select
  using (public.is_admin() or account_id = auth.uid());

create policy audit_read on public.audit_log for select using (public.is_admin());

-- role_grants and teams: readable by all signed-in users, admin-writable.
-- A competition organiser may also grant captain/coach within their own
-- competition, so running a tournament does not require pestering an admin.
create policy grants_read on public.role_grants for select
  using (auth.uid() is not null);
create policy grants_write on public.role_grants for all
  using (public.is_admin()
         or (competition_id is not null
             and public.has_grant_on_competition(competition_id,
                                                 array['organiser'])))
  with check (public.is_admin()
              or (competition_id is not null and role <> 'organiser'
                  and public.has_grant_on_competition(competition_id,
                                                      array['organiser'])));
create policy teams_read on public.teams for select using (true);
create policy teams_write on public.teams for all
  using (public.is_admin()) with check (public.is_admin());


-- =====================================================================
-- 8. AUDIT
-- =====================================================================

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor_id, action, table_name, row_id, before, after)
  values (auth.uid(), lower(tg_op), tg_table_name,
          coalesce(new.id, old.id)::text,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger audit_charges  after insert or update or delete on public.charges
  for each row execute function public.audit_row();
create trigger audit_payments after insert or update or delete on public.payments
  for each row execute function public.audit_row();
create trigger audit_profiles after update on public.profiles
  for each row execute function public.audit_row();
create trigger audit_periods  after update on public.billing_periods
  for each row execute function public.audit_row();

-- RLS and object privileges ship with the tables, not in a later policy PR.
-- SECURITY INVOKER views preserve the caller's future base-table policies.
-- Supabase's default table/sequence grants and default PUBLIC function EXECUTE
-- must be revoked explicitly. A privileged database owner can still maintain
-- the database; these grants are not intended to sandbox its administrator.
alter table public.fee_schedules enable row level security;
alter table public.billing_periods enable row level security;
alter table public.charges enable row level security;
alter table public.payments enable row level security;
alter table public.period_player_summaries enable row level security;
alter table public.period_account_summaries enable row level security;
alter table public.audit_log enable row level security;

revoke all on table public.fee_schedules, public.billing_periods, public.charges,
  public.payments, public.period_player_summaries, public.period_account_summaries,
  public.audit_log from public, anon, authenticated;
revoke all on table public.v_account_balance, public.v_account_ledger,
  public.v_public_roster from public, anon, authenticated;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;

revoke all on function public.lock_billing() from public, anon, authenticated;
revoke all on function public.lock_billing_statement() from public, anon, authenticated;
revoke all on function public.require_open_billing_date(date, uuid) from public, anon, authenticated;
revoke all on function public.charges_are_immutable() from public, anon, authenticated;
revoke all on function public.payments_are_immutable() from public, anon, authenticated;
revoke all on function public.guard_billing_period() from public, anon, authenticated;
revoke all on function public.freeze_billing_history() from public, anon, authenticated;
revoke all on function public.guard_billed_game() from public, anon, authenticated;
revoke all on function public.guard_billed_registration() from public, anon, authenticated;
revoke all on function public.resolve_game_fee(uuid) from public, anon, authenticated;
revoke all on function public.resolve_no_show_fee(uuid) from public, anon, authenticated;
revoke all on function public.write_game_attendance_charges(uuid) from public, anon, authenticated;
revoke all on function public.finalise_game_attendance(uuid) from public, anon, authenticated;
revoke all on function public.assign_to_periods() from public, anon, authenticated;
revoke all on function public.write_billing_period_summaries(uuid) from public, anon, authenticated;
revoke all on function public.close_billing_period(uuid) from public, anon, authenticated;
revoke all on function public.audit_row() from public, anon, authenticated;


-- =====================================================================
-- 9. HOSTED TOURNAMENTS  (phase 2 — additive, nothing above changes)
--
--   Turning on the case where CalBlue *runs* the competition and other
--   clubs enter it. Everything in this section is a new table or a new
--   policy; the member-facing model in sections 1–8 is untouched, and a
--   Saturday pickup behaves exactly as it did before.
-- =====================================================================

-- One club's team entering one tournament we host.
create table public.tournament_entries (
  id                  uuid primary key default gen_random_uuid(),
  competition_id      uuid not null references public.competitions(id) on delete cascade,
  team_id             uuid not null references public.teams(id) on delete restrict,
  manager_account_id  uuid references public.profiles(id) on delete set null,
  status              text not null default 'draft'
                      check (status in ('draft','submitted','approved',
                                        'waitlisted','rejected','withdrawn')),
  group_id            uuid,                       -- set below, after groups exist
  seed                int,
  contact_name        text,
  contact_email       citext,
  contact_phone       text,
  entry_fee_amount    numeric(10,2) check (entry_fee_amount >= 0),
  note                text,
  submitted_at        timestamptz,
  decided_at          timestamptz,
  decided_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (competition_id, team_id)
);
create index entries_by_comp    on public.tournament_entries(competition_id, status);
create index entries_by_manager on public.tournament_entries(manager_account_id);
create trigger entries_touch before update on public.tournament_entries
  for each row execute function public.touch_updated_at();

-- Only a competition in 'host' mode can take entries.
create or replace function public.check_entry_is_hosted() returns trigger
language plpgsql as $$
begin
  if (select hosting_mode from public.competitions where id = new.competition_id)
     <> 'host' then
    raise exception 'this competition does not accept team entries';
  end if;
  return new;
end $$;
create trigger entries_hosted before insert or update of competition_id
  on public.tournament_entries
  for each row execute function public.check_entry_is_hosted();

-- Group stage, if the tournament has one. Knockout rounds are handled by
-- games.stage_label + round_number rather than a bracket engine.
create table public.competition_groups (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  label          text not null,                   -- 'Group A'
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now(),
  unique (competition_id, label)
);
alter table public.tournament_entries
  add constraint entries_group_fk foreign key (group_id)
  references public.competition_groups(id) on delete set null;

-- The squad a visiting club submits. Reuses `players` — which is exactly why
-- players.account_id is nullable: a visiting player never needs a login.
create table public.entry_roster (
  id             uuid primary key default gen_random_uuid(),
  entry_id       uuid not null references public.tournament_entries(id) on delete cascade,
  player_id      uuid not null references public.players(id) on delete restrict,
  jersey_number  int check (jersey_number between 0 and 99),
  positions      text[] not null default '{}',
  status         text not null default 'submitted'
                 check (status in ('submitted','approved','ineligible')),
  note           text,
  created_at     timestamptz not null default now(),
  unique (entry_id, player_id)
);
create unique index entry_roster_number
  on public.entry_roster(entry_id, jersey_number)
  where jersey_number is not null and status <> 'ineligible';

-- Results. Both managers confirm; an admin can override.
create table public.game_results (
  game_id            uuid primary key references public.games(id) on delete cascade,
  home_score         int not null check (home_score >= 0),
  away_score         int not null check (away_score >= 0),
  outcome            text not null default 'played'
                     check (outcome in ('played','home_forfeit','away_forfeit','abandoned')),
  confirmed_by_home  boolean not null default false,
  confirmed_by_away  boolean not null default false,
  recorded_by        uuid references public.profiles(id),
  recorded_at        timestamptz not null default now(),
  note               text
);

-- Optional, and worth having: it is what produces a top-scorer table.
create table public.game_events (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games(id) on delete cascade,
  team_id     uuid references public.teams(id) on delete set null,
  player_id   uuid references public.players(id) on delete set null,
  minute      int check (minute between 0 and 130),
  kind        text not null
              check (kind in ('goal','own_goal','assist','yellow','red')),
  note        text,
  recorded_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index events_by_game on public.game_events(game_id);

-- Entry fees are ordinary charges, owed by the manager's account.
alter table public.charges
  add constraint charges_entry_fk foreign key (entry_id)
  references public.tournament_entries(id) on delete restrict;

-- A visiting club's manager is one more scoped grant, exactly like a captain.
alter table public.role_grants
  add column tournament_entry_id uuid
  references public.tournament_entries(id) on delete cascade;
alter table public.role_grants drop constraint role_grant_scope_required;
alter table public.role_grants
  add constraint role_grant_scope_required
  check (competition_id is not null or game_id is not null
         or team_id is not null or tournament_entry_id is not null);
alter table public.role_grants drop constraint role_grant_allowed;
alter table public.role_grants
  add constraint role_grant_allowed
  check (role in ('organiser','manager','captain','coach','treasurer',
                  'team_manager'));


-- --- the tables the public tournament pages read ---------------------

create or replace view public.v_standings as
with sides as (
  select g.competition_id, g.home_team_id as team_id,
         r.home_score as gf, r.away_score as ga
    from public.games g
    join public.game_results r on r.game_id = g.id
   where r.outcome <> 'abandoned'
     and g.home_team_id is not null and g.away_team_id is not null
  union all
  select g.competition_id, g.away_team_id,
         r.away_score, r.home_score
    from public.games g
    join public.game_results r on r.game_id = g.id
   where r.outcome <> 'abandoned'
     and g.home_team_id is not null and g.away_team_id is not null
)
select s.competition_id,
       e.group_id,
       s.team_id,
       count(*)                                   as played,
       count(*) filter (where s.gf > s.ga)        as won,
       count(*) filter (where s.gf = s.ga)        as drawn,
       count(*) filter (where s.gf < s.ga)        as lost,
       sum(s.gf)                                  as goals_for,
       sum(s.ga)                                  as goals_against,
       sum(s.gf) - sum(s.ga)                      as goal_difference,
       count(*) filter (where s.gf > s.ga) * c.points_win
     + count(*) filter (where s.gf = s.ga) * c.points_draw as points
  from sides s
  join public.competitions c on c.id = s.competition_id
  left join public.tournament_entries e
         on e.competition_id = s.competition_id and e.team_id = s.team_id
 group by s.competition_id, e.group_id, s.team_id, c.points_win, c.points_draw;

create or replace view public.v_scorers as
select g.competition_id, ev.team_id, ev.player_id,
       count(*) filter (where ev.kind = 'goal')   as goals,
       count(*) filter (where ev.kind = 'assist') as assists
  from public.game_events ev
  join public.games g on g.id = ev.game_id
 where ev.kind in ('goal','assist') and ev.player_id is not null
 group by g.competition_id, ev.team_id, ev.player_id;


-- --- who may touch what ----------------------------------------------

create or replace function public.manages_entry(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tournament_entries te
     where te.id = e
       and (te.manager_account_id = auth.uid()
            or exists (select 1 from public.role_grants rg
                        where rg.account_id = auth.uid()
                          and rg.tournament_entry_id = te.id)))
$$;

alter table public.tournament_entries  enable row level security;
alter table public.competition_groups  enable row level security;
alter table public.entry_roster        enable row level security;
alter table public.game_results        enable row level security;
alter table public.game_events         enable row level security;

-- an approved entry is public (it is on the fixture list); your own entry is
-- visible to you at every status
create policy entries_read on public.tournament_entries for select
  using (public.is_admin()
         or status = 'approved'
         or public.manages_entry(id));
create policy entries_insert on public.tournament_entries for insert
  with check (public.is_admin() or manager_account_id = auth.uid());
create policy entries_update on public.tournament_entries for update
  using (public.is_admin() or public.manages_entry(id));
-- a manager may edit their entry but never approve it, seed it, or set its fee
create or replace function public.guard_entry_decision() returns trigger
language plpgsql as $$
begin
  if (new.status, new.seed, new.group_id, new.entry_fee_amount)
     is distinct from (old.status, old.seed, old.group_id, old.entry_fee_amount)
     and not public.is_admin() then
    -- the one status change a manager may make is withdrawing or submitting
    if new.status not in ('submitted','withdrawn')
       or (new.seed, new.group_id, new.entry_fee_amount)
          is distinct from (old.seed, old.group_id, old.entry_fee_amount) then
      raise exception 'only an admin may accept, seed or price an entry';
    end if;
  end if;
  return new;
end $$;
create trigger entries_guard before update on public.tournament_entries
  for each row execute function public.guard_entry_decision();

create policy groups_read on public.competition_groups for select using (true);
create policy groups_write on public.competition_groups for all
  using (public.is_admin()) with check (public.is_admin());

-- a squad list is visible to its own manager and to admins; to everyone else
-- only if the organiser turned rosters on for that tournament
create policy roster_read on public.entry_roster for select
  using (public.is_admin()
         or public.manages_entry(entry_id)
         or exists (select 1 from public.tournament_entries te
                      join public.competitions c on c.id = te.competition_id
                     where te.id = entry_id and c.roster_public
                       and te.status = 'approved'));
create policy roster_write on public.entry_roster for all
  using (public.is_admin() or public.manages_entry(entry_id))
  with check (public.is_admin() or public.manages_entry(entry_id));

create policy results_read on public.game_results for select using (true);
create policy results_write on public.game_results for all
  using (public.is_admin() or public.manages_game(game_id))
  with check (public.is_admin() or public.manages_game(game_id));

create policy events_read on public.game_events for select using (true);
create policy events_write on public.game_events for all
  using (public.is_admin() or public.manages_game(game_id))
  with check (public.is_admin() or public.manages_game(game_id));


-- A visiting manager needs to create and read the people on their own squad.
-- Those people have no login, so the ordinary "it's my account" rules in
-- section 7 do not reach them. RLS policies are OR-ed, so these widen the
-- existing ones rather than replacing them.
create policy players_read_by_entry_manager on public.players for select
  using (exists (select 1 from public.entry_roster er
                  where er.player_id = players.id
                    and public.manages_entry(er.entry_id)));

create policy players_insert_by_entry_manager on public.players for insert
  with check (account_id is null
              and exists (select 1 from public.tournament_entries te
                           where te.manager_account_id = auth.uid()));

create policy players_update_by_entry_manager on public.players for update
  using (account_id is null
         and exists (select 1 from public.entry_roster er
                      where er.player_id = players.id
                        and public.manages_entry(er.entry_id)));


-- Confirming a result. The organiser records the score; each side confirms
-- it. A side-manager may flip their own confirmation flag and nothing else.
create or replace function public.manages_game_side(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.games gm
      join public.tournament_entries te
        on te.competition_id = gm.competition_id
       and te.team_id in (gm.home_team_id, gm.away_team_id)
     where gm.id = g and public.manages_entry(te.id))
$$;

drop policy results_write on public.game_results;
create policy results_write on public.game_results for all
  using (public.is_admin() or public.manages_game(game_id)
         or public.manages_game_side(game_id))
  with check (public.is_admin() or public.manages_game(game_id)
              or public.manages_game_side(game_id));

create or replace function public.guard_result_confirmation() returns trigger
language plpgsql as $$
begin
  if public.is_admin() or public.manages_game(new.game_id) then
    return new;
  end if;
  if (new.home_score, new.away_score, new.outcome, new.note)
     is distinct from (old.home_score, old.away_score, old.outcome, old.note) then
    raise exception 'a team manager may confirm a score, not change it';
  end if;
  return new;
end $$;

create trigger results_guard before update on public.game_results
  for each row execute function public.guard_result_confirmation();


-- =====================================================================
-- 10. CLIENTS: PUSH AND NOTIFICATIONS  (phase 2 — see DESIGN.md §12)
--
--   A phone app needs no new domain tables: it authenticates as the member
--   and the policies in section 7 already decide what it may see. These two
--   exist so we can reach a member at all, and they are wanted for email
--   reminders whether or not an app is ever built.
-- =====================================================================

create table public.devices (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.profiles(id) on delete cascade,
  platform     text not null check (platform in ('ios','android','web')),
  push_token   text not null,
  app_version  text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (platform, push_token)
);
create index devices_by_account on public.devices(account_id);

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.profiles(id) on delete cascade,
  kind          text not null
                check (kind in ('registration_confirmed','waitlist_promoted',
                                'game_reminder','game_cancelled',
                                'statement_ready','entry_decision')),
  title         text not null,
  body          text,
  payload       jsonb not null default '{}'::jsonb,   -- deep-link target
  scheduled_for timestamptz not null default now(),
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index notifications_pending on public.notifications(scheduled_for)
  where sent_at is null;
create index notifications_by_account
  on public.notifications(account_id, created_at desc);

alter table public.devices       enable row level security;
alter table public.notifications enable row level security;

-- your devices and your notifications, nobody else's
create policy devices_own on public.devices for all
  using (account_id = auth.uid()) with check (account_id = auth.uid());
create policy notifications_own on public.notifications for select
  using (account_id = auth.uid());
create policy notifications_mark_read on public.notifications for update
  using (account_id = auth.uid()) with check (account_id = auth.uid());
-- only server-side jobs (service role, which bypasses RLS) create them

-- --- offline-safe check-in -------------------------------------------
-- The captain's phone queues marks with no signal and replays them on
-- reconnect. Two properties make that safe, and both already exist:
--   * game_registrations has unique (game_id, player_id), so a sync is an
--     upsert on a natural key — replaying the same queue changes nothing
--   * attendance is a state, not an event stream, so last-write-wins is a
--     correct and comprehensible rule
-- The client passes the time it recorded the mark; a stale queue can never
-- overwrite a more recent correction.
create or replace function public.sync_attendance(
  p_game       uuid,
  p_player     uuid,
  p_attendance text,
  p_marked_at  timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
declare applied boolean;
begin
  if not (public.is_admin() or public.manages_game(p_game)) then
    raise exception 'only a captain or an admin may record attendance';
  end if;
  if p_attendance not in ('unknown','present','absent','excused') then
    raise exception 'bad attendance value %', p_attendance;
  end if;

  update public.game_registrations
     set attendance    = p_attendance,
         checked_in_at = p_marked_at,
         checked_in_by = auth.uid()
   where game_id = p_game
     and player_id = p_player
     and (checked_in_at is null or checked_in_at < p_marked_at)
  returning true into applied;

  return coalesce(applied, false);   -- false = a newer mark already won
end $$;
