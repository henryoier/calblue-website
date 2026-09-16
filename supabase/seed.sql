-- =====================================================================
-- CalBlue -- disposable development/demo seed, version 1
--
-- Apply ONLY after migrations 0001, 0002 and 0003 in an otherwise empty,
-- inactive, DISPOSABLE Supabase project, as the application-table owner.
-- A service-role key or an authenticated admin JWT is NOT the database owner.
-- No real member data, passwords, external URLs or real opponents are included.
--
-- DEFAULT OFF: uncomment the one confirmation line below in the scratch SQL
-- Editor copy after checking the project. The repository version stays off.
-- Run this WHOLE file, not a selection. With psql, use -v ON_ERROR_STOP=1.
--
-- Accounts/identities are invented examples, not working browser logins.
-- Direct SQL creates no password/auth.identities entry and requests no email.
-- The six reserved example.com emails must never be changed to real addresses.
--
-- Reruns validate a completion marker and return BEFORE fixture writes. They
-- never reset edited profiles, roles, dates, registrations or financial history.
-- Broken/unknown markers and nonempty first-run databases are rejected, not
-- repaired. This is not a reset/import/migration or a production bootstrap.
-- =====================================================================

BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = '';
-- Clear any inherited confirmation; authorization must be explicit this run.
SET LOCAL calblue.seed_confirmation = '';
-- SET LOCAL calblue.seed_confirmation = 'disposable-demo-only';

DO $seed$
DECLARE
  schema_owner oid;
  table_name text;
  table_oid oid;
  existing_marker jsonb;
  installed_at timestamptz := now();
  anchor_date date := (installed_at at time zone 'America/Los_Angeles')::date;
  past_date date := anchor_date - 7;
  expected_counts jsonb := '{"accounts":6,"players":12,"clubs":1,"teams":1,"venues":2,"competitions":1,"games":5,"competition_registrations":10,"game_registrations":29,"role_grants":1,"fee_schedules":2,"billing_periods":1,"charges":3,"payments":1}'::jsonb;
  fixture_counts jsonb;
BEGIN
  -- Real database-role/catalog checks, not JWT-based ownership.
  SELECT relowner INTO schema_owner FROM pg_catalog.pg_class
   WHERE oid = pg_catalog.to_regclass('public.profiles') AND relkind = 'r';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seed_migrations_required' USING ERRCODE = '23514';
  END IF;
  IF current_user <> pg_catalog.pg_get_userbyid(schema_owner) THEN
    RAISE EXCEPTION 'seed_database_owner_required' USING ERRCODE = '42501';
  END IF;
  IF current_setting('calblue.seed_confirmation', true) IS DISTINCT FROM 'disposable-demo-only' THEN
    RAISE EXCEPTION 'seed_disposable_confirmation_required' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'seed_requires_read_committed' USING ERRCODE = '0A000';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'profiles','players','venues','clubs','teams','competitions','games',
    'role_grants','competition_registrations','game_registrations','fee_schedules',
    'billing_periods','charges','payments','period_player_summaries',
    'period_account_summaries','audit_log'
  ] LOOP
    table_oid := pg_catalog.to_regclass('public.' || table_name);
    IF table_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
       WHERE c.oid = table_oid AND c.relkind = 'r'
         AND c.relowner = schema_owner AND c.relrowsecurity
    ) OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = table_oid) THEN
      RAISE EXCEPTION 'seed_migrations_required: %', table_name USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regprocedure('public.touch_updated_at()') IS NULL
     OR pg_catalog.to_regprocedure('public.lock_billing()') IS NULL
     OR pg_catalog.to_regprocedure('public.finalise_game_attendance_internal(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('public.close_billing_period_internal(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('public.read_public_roster()') IS NULL
     OR pg_catalog.to_regprocedure('public.read_game_emergency_contacts(uuid)') IS NULL THEN
    RAISE EXCEPTION 'seed_migrations_required' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.has_function_privilege('authenticated',
       'public.finalise_game_attendance_internal(uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated',
       'public.close_billing_period_internal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'seed_private_writer_grants_invalid' USING ERRCODE = '23514';
  END IF;

  -- All seed runners take the same lock order. Ordinary app writes participating
  -- in billing are serialized too; first-run table locks also cover Auth and
  -- tables outside that protocol.
  PERFORM public.lock_billing();
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('calblue:demo-seed:v1', 0));

  SELECT raw_app_meta_data -> 'calblue_demo_seed' INTO existing_marker
    FROM auth.users WHERE id = '11111111-0000-4000-a000-000000000001';
  IF FOUND THEN
    IF jsonb_typeof(existing_marker) IS DISTINCT FROM 'object'
       OR existing_marker -> 'version' IS DISTINCT FROM '1'::jsonb
       OR existing_marker ->> 'status' IS DISTINCT FROM 'complete'
       OR existing_marker ->> 'seed' IS DISTINCT FROM 'calblue-demo'
       OR existing_marker -> 'counts' IS DISTINCT FROM expected_counts
       OR jsonb_typeof(existing_marker -> 'anchor_date') IS DISTINCT FROM 'string'
       OR jsonb_typeof(existing_marker -> 'installed_at') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'seed_marker_invalid_or_account_collision' USING ERRCODE = '23514';
    END IF;
    -- Invalid date casts abort before writes; do not catch/continue past errors.
    IF NOT pg_catalog.isfinite((existing_marker ->> 'installed_at')::timestamptz)
       OR NOT pg_catalog.isfinite((existing_marker ->> 'anchor_date')::date)
       OR (((existing_marker ->> 'installed_at')::timestamptz
            AT TIME ZONE 'America/Los_Angeles')::date
           IS DISTINCT FROM (existing_marker ->> 'anchor_date')::date) THEN
      RAISE EXCEPTION 'seed_marker_invalid_or_account_collision' USING ERRCODE = '23514';
    END IF;
    RAISE NOTICE 'CalBlue demo seed v1 already completed; no fixture rows changed.';
    RETURN;
  END IF;

  -- First-run only. Locks prevent an unrelated signup/insert from racing the
  -- empty-project check. Use an inactive scratch project: concurrent owner/Auth
  -- maintenance can deadlock and abort safely instead of partially installing.
  LOCK TABLE auth.users, public.profiles, public.players, public.venues,
    public.clubs, public.teams, public.competitions, public.games,
    public.role_grants, public.competition_registrations, public.game_registrations,
    public.fee_schedules, public.billing_periods, public.charges, public.payments,
    public.period_player_summaries, public.period_account_summaries, public.audit_log
    IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM auth.users)
     OR EXISTS (SELECT 1 FROM public.profiles)
     OR EXISTS (SELECT 1 FROM public.players)
     OR EXISTS (SELECT 1 FROM public.venues)
     OR EXISTS (SELECT 1 FROM public.clubs)
     OR EXISTS (SELECT 1 FROM public.teams)
     OR EXISTS (SELECT 1 FROM public.competitions)
     OR EXISTS (SELECT 1 FROM public.games)
     OR EXISTS (SELECT 1 FROM public.role_grants)
     OR EXISTS (SELECT 1 FROM public.competition_registrations)
     OR EXISTS (SELECT 1 FROM public.game_registrations)
     OR EXISTS (SELECT 1 FROM public.fee_schedules)
     OR EXISTS (SELECT 1 FROM public.billing_periods)
     OR EXISTS (SELECT 1 FROM public.charges)
     OR EXISTS (SELECT 1 FROM public.payments)
     OR EXISTS (SELECT 1 FROM public.period_player_summaries)
     OR EXISTS (SELECT 1 FROM public.period_account_summaries)
     OR EXISTS (SELECT 1 FROM public.audit_log) THEN
    RAISE EXCEPTION 'seed_requires_empty_disposable_project' USING ERRCODE = '23514';
  END IF;

  -- Avoid inheriting an unrelated SQL-session JWT as the actor of owner writes.
  PERFORM pg_catalog.set_config('request.jwt.claims', '{}', true);
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claim.role', '', true);

  -- ---------------------------------------------------------------- accounts
  -- profiles rows are created by the handle_new_user trigger on auth.users, so
  -- the accounts go in first and then we fill in names and roles.
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data,
                          created_at, updated_at)
  values
    ('11111111-0000-4000-a000-000000000001', 'ada@example.com',
     '{"display_name":"Ada Demo"}'::jsonb, '{}'::jsonb, now(), now()),
    ('11111111-0000-4000-a000-000000000002', 'ben@example.com',
     '{"display_name":"Ben Demo"}'::jsonb, '{}'::jsonb, now(), now()),
    ('11111111-0000-4000-a000-000000000003', 'chen@example.com',
     '{"display_name":"Chen Demo"}'::jsonb, '{}'::jsonb, now(), now()),
    ('11111111-0000-4000-a000-000000000004', 'dara@example.com',
     '{"display_name":"Dara Demo"}'::jsonb, '{}'::jsonb, now(), now()),
    ('11111111-0000-4000-a000-000000000005', 'eve@example.com',
     '{"display_name":"Eve Demo"}'::jsonb, '{}'::jsonb, now(), now()),
    ('11111111-0000-4000-a000-000000000006', 'finn@example.com',
     '{"display_name":"Finn Demo"}'::jsonb, '{}'::jsonb, now(), now());

  -- Roles are additive. Ada runs the club; Chen plays and keeps the books; Dara
  -- organises one competition and holds no club-wide role at all.
  update public.profiles set display_name = 'Ada Demo',   roles = '{player,admin}'
    where id = '11111111-0000-4000-a000-000000000001' and roles is distinct from '{player,admin}'::text[];
  update public.profiles set display_name = 'Ben Demo', roles = '{player}'
    where id = '11111111-0000-4000-a000-000000000002' and roles is distinct from '{player}'::text[];
  update public.profiles set display_name = 'Chen Demo',   roles = '{player,treasurer}'
    where id = '11111111-0000-4000-a000-000000000003' and roles is distinct from '{player,treasurer}'::text[];
  update public.profiles set display_name = 'Dara Demo', roles = '{}'
    where id = '11111111-0000-4000-a000-000000000004' and roles is distinct from '{}'::text[];
  update public.profiles set display_name = 'Eve Demo', roles = '{player,coach}'
    where id = '11111111-0000-4000-a000-000000000005' and roles is distinct from '{player,coach}'::text[];
  update public.profiles set display_name = 'Finn Demo', roles = '{player}'
    where id = '11111111-0000-4000-a000-000000000006' and roles is distinct from '{player}'::text[];

  -- ------------------------------------------------------------------ clubs
  insert into public.clubs (id, name, short_name, city, is_us) values
    ('22222222-0000-4000-a000-000000000001', 'CalBlue Demo Club', 'CalBlue Demo', 'Fictional demo city', true);

  insert into public.teams (id, club_id, name, short_name, is_default) values
    ('33333333-0000-4000-a000-000000000001', '22222222-0000-4000-a000-000000000001',
     'CalBlue Demo Team', 'CalBlue Demo', true);

  -- ----------------------------------------------------------------- venues
  insert into public.venues (id, name, address, surface, timezone, notes) values
    ('44444444-0000-4000-a000-000000000001', 'Demo Meadow Field', 'Fictional demo location A',
     'grass', 'America/Los_Angeles', 'Invented venue for disposable demo data only.'),
    ('44444444-0000-4000-a000-000000000002', 'Demo Practice Turf', 'Fictional demo location B',
     'turf', 'America/Los_Angeles', 'Invented turf venue; no real access instructions.');

  -- --------------------------------------------------------------- identities
  -- One account holds at most one identity. The remaining identities deliberately
  -- have no login: Grace is a drop-in guest, Hugo is Eve's child and Eve pays for
  -- him, and four fixture-only teammates exercise unclaimed roster records.
  insert into public.players
    (id, account_id, guardian_account_id, display_name, date_of_birth,
     default_positions, preferred_number, verification_status, is_public, claim_code)
  values
    ('55555555-0000-4000-a000-000000000001', '11111111-0000-4000-a000-000000000001', null,
     'Ada Demo',    '1991-03-04', '{CM,CDM}', 8,  'verified', true,  null),
    ('55555555-0000-4000-a000-000000000002', '11111111-0000-4000-a000-000000000002', null,
     'Ben Demo',  '1988-11-21', '{ST}',     9,  'verified', true,  null),
    ('55555555-0000-4000-a000-000000000003', '11111111-0000-4000-a000-000000000003', null,
     'Chen Demo',    '1994-07-09', '{GK}',     1,  'verified', true,  null),
    ('55555555-0000-4000-a000-000000000004', '11111111-0000-4000-a000-000000000004', null,
     'Dara Demo',  '1985-01-30', '{CB}',     5,  'verified', false, null),
    ('55555555-0000-4000-a000-000000000005', '11111111-0000-4000-a000-000000000005', null,
     'Eve Demo', '1990-09-15', '{LW}',     11, 'verified', true,  null),
    ('55555555-0000-4000-a000-000000000006', '11111111-0000-4000-a000-000000000006', null,
     'Finn Demo',  '1997-05-02', '{RB}',     2,  'pending',  false, null),
    -- no account at all: turned up to a pickup, was recorded, can claim later
    ('55555555-0000-4000-a000-000000000007', null, null,
     'Grace Demo',  null,         '{CM}',     14, 'pending',  false, 'DEMO-GRACE-V1'),
    -- a child: no login of their own, Eve is the guardian and therefore the payer
    ('55555555-0000-4000-a000-000000000008', null, '11111111-0000-4000-a000-000000000005',
     'Hugo Demo', (anchor_date - interval '10 years')::date, '{ST}',    7,  'verified', false, null),
    -- unclaimed teammates: enough depth for useful roster and fixture screens
    ('55555555-0000-4000-a000-000000000009', null, null,
     'Imani Demo',   null,         '{LB}',     4,  'verified', true,  'DEMO-IMANI-V1'),
    ('55555555-0000-4000-a000-000000000010', null, null,
     'Jules Demo',   null,         '{CB}',     6,  'verified', true,  'DEMO-JULES-V1'),
    ('55555555-0000-4000-a000-000000000011', null, null,
     'Kai Demo',   null,         '{RW}',    10,  'verified', true,  'DEMO-KAI-V1'),
    ('55555555-0000-4000-a000-000000000012', null, null,
     'Noor Demo',   null,         '{CM}',    15,  'verified', true,  'DEMO-NOOR-V1');

  -- ----------------------------------------------------------- competitions
  insert into public.competitions
    (id, name, kind, season_label, organiser, start_date, end_date, status,
     roster_approval, default_fee_per_game, default_no_show_fee)
  values
    ('77777777-0000-4000-a000-000000000001', 'Demo Cup', 'cup', 'Demo ' || to_char(anchor_date, 'YYYY'), 'CalBlue Demo',
     anchor_date + 14, anchor_date + 28,
     'published', true, 25.00, 0.00);

  -- ------------------------------------------------------------ scoped roles
  -- Dara has no club-wide role and manages only Demo Cup fixtures/approvals,
  -- never private accounts or club-wide finances. The competition comes first
  -- because role_grants has an immediate foreign key to it.
  insert into public.role_grants (id, account_id, role, competition_id, game_id, team_id)
  values ('66666666-0000-4000-a000-000000000001', '11111111-0000-4000-a000-000000000004',
          'organiser', '77777777-0000-4000-a000-000000000001', null, null);

  -- ------------------------------------------------------------------ games
  -- Dates are relative to the first seed run so a newly created dev database has
  -- current-looking fixtures. The whole-seed marker makes later runs inert.
  insert into public.games
    (id, competition_id, team_id, game_type, title, opponent, home_away, venue_id,
     field_label, timezone, gather_time, start_time, end_time, capacity,
     registration_closes_at, status, attendance_locked_at, fee_override, kit_color, notes)
  values
    -- a pickup seven days after the first install, with a deliberate waitlist
    ('88888888-0000-4000-a000-000000000001', null, '33333333-0000-4000-a000-000000000001',
     'pickup', 'Demo upcoming pickup', null, 'home',
     '44444444-0000-4000-a000-000000000001', 'Pitch 2', 'America/Los_Angeles',
     (anchor_date + 7 + time '08:30') at time zone 'America/Los_Angeles',
     (anchor_date + 7 + time '09:00') at time zone 'America/Los_Angeles',
     (anchor_date + 7 + time '11:00') at time zone 'America/Los_Angeles',
     4, (anchor_date + 6 + time '20:00') at time zone 'America/Los_Angeles',
     'published', null, 10.00, 'blue', 'Bring both shirts.'),
    -- a cup fixture further out
    ('88888888-0000-4000-a000-000000000002', '77777777-0000-4000-a000-000000000001',
     '33333333-0000-4000-a000-000000000001',
     'cup', 'Demo Cup — group stage', 'Demo Amber FC', 'home',
     '44444444-0000-4000-a000-000000000002', 'Turf 1', 'America/Los_Angeles',
     (anchor_date + 14 + time '13:15') at time zone 'America/Los_Angeles',
     (anchor_date + 14 + time '14:00') at time zone 'America/Los_Angeles',
     (anchor_date + 14 + time '16:00') at time zone 'America/Los_Angeles',
     16, (anchor_date + 13 + time '20:00') at time zone 'America/Los_Angeles',
     'published', null, null, 'white', null),
    -- two more cup fixtures make the competition schedule useful on its own
    ('88888888-0000-4000-a000-000000000004', '77777777-0000-4000-a000-000000000001',
     '33333333-0000-4000-a000-000000000001',
     'cup', 'Demo Cup — group stage 2', 'Demo Silver FC', 'away',
     '44444444-0000-4000-a000-000000000001', 'Pitch 1', 'America/Los_Angeles',
     (anchor_date + 21 + time '09:15') at time zone 'America/Los_Angeles',
     (anchor_date + 21 + time '10:00') at time zone 'America/Los_Angeles',
     (anchor_date + 21 + time '12:00') at time zone 'America/Los_Angeles',
     16, (anchor_date + 20 + time '20:00') at time zone 'America/Los_Angeles',
     'published', null, null, 'blue', 'Meet by the north entrance.'),
    ('88888888-0000-4000-a000-000000000005', '77777777-0000-4000-a000-000000000001',
     '33333333-0000-4000-a000-000000000001',
     'cup', 'Demo Cup — group stage 3', 'Demo Violet FC', 'neutral',
     '44444444-0000-4000-a000-000000000002', 'Turf 2', 'America/Los_Angeles',
     (anchor_date + 28 + time '15:15') at time zone 'America/Los_Angeles',
     (anchor_date + 28 + time '16:00') at time zone 'America/Los_Angeles',
     (anchor_date + 28 + time '18:00') at time zone 'America/Los_Angeles',
     16, (anchor_date + 27 + time '20:00') at time zone 'America/Los_Angeles',
     'published', null, null, 'white', null),
    -- insert the past pickup as completed; the real billing writer locks it later
    ('88888888-0000-4000-a000-000000000003', null, '33333333-0000-4000-a000-000000000001',
     'pickup', 'Demo past pickup', null, 'home',
     '44444444-0000-4000-a000-000000000001', 'Pitch 2', 'America/Los_Angeles',
     (anchor_date - 7 + time '08:30') at time zone 'America/Los_Angeles',
     (anchor_date - 7 + time '09:00') at time zone 'America/Los_Angeles',
     (anchor_date - 7 + time '11:00') at time zone 'America/Los_Angeles',
     12, (anchor_date - 8 + time '20:00') at time zone 'America/Los_Angeles',
     'completed', null,
     10.00, 'blue', null);

  -- ------------------------------------------------------- season roster
  insert into public.competition_registrations
    (id, competition_id, player_id, status, jersey_number, positions)
  values
    ('99999999-0000-4000-a000-000000000001', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000001', 'approved', 8, '{CM}'),
    ('99999999-0000-4000-a000-000000000002', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000002', 'approved', 9, '{ST}'),
    ('99999999-0000-4000-a000-000000000003', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000003', 'approved', 1, '{GK}'),
    -- Finn is unverified, so his request is still pending: the verification queue has work
    ('99999999-0000-4000-a000-000000000004', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000006', 'pending', 2, '{RB}'),
    ('99999999-0000-4000-a000-000000000005', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000005', 'approved', 11, '{LW}'),
    ('99999999-0000-4000-a000-000000000006', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000008', 'approved', 7, '{ST}'),
    ('99999999-0000-4000-a000-000000000007', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000009', 'approved', 4, '{LB}'),
    ('99999999-0000-4000-a000-000000000008', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000010', 'approved', 6, '{CB}'),
    ('99999999-0000-4000-a000-000000000009', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000011', 'approved', 10, '{RW}'),
    ('99999999-0000-4000-a000-000000000010', '77777777-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000012', 'approved', 15, '{CM}');

  -- --------------------------------------------------- game registrations
  -- The upcoming pickup has capacity 4: four registered, two waiting.
  insert into public.game_registrations
    (id, game_id, player_id, status, participation, jersey_number, positions,
     attendance, registered_at)
  values
    ('aaaaaaaa-0000-4000-a000-000000000001', '88888888-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'unknown', now() - interval '3 days'),
    ('aaaaaaaa-0000-4000-a000-000000000002', '88888888-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'unknown', now() - interval '3 days'),
    ('aaaaaaaa-0000-4000-a000-000000000003', '88888888-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '2 days'),
    ('aaaaaaaa-0000-4000-a000-000000000004', '88888888-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000005', 'registered', 'player', 11, '{LW}', 'unknown', now() - interval '2 days'),
    ('aaaaaaaa-0000-4000-a000-000000000005', '88888888-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000004', 'waitlisted', 'player', 5, '{CB}', 'unknown', now() - interval '1 day'),
    ('aaaaaaaa-0000-4000-a000-000000000006', '88888888-0000-4000-a000-000000000001',
     '55555555-0000-4000-a000-000000000008', 'waitlisted', 'player', 7, '{ST}', 'unknown', now() - interval '4 hours'),

    -- all three Demo Cup fixtures have selections to render
    ('aaaaaaaa-0000-4000-a000-000000000021', '88888888-0000-4000-a000-000000000002',
     '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'unknown', now() - interval '3 days'),
    ('aaaaaaaa-0000-4000-a000-000000000022', '88888888-0000-4000-a000-000000000002',
     '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'unknown', now() - interval '3 days'),
    ('aaaaaaaa-0000-4000-a000-000000000023', '88888888-0000-4000-a000-000000000002',
     '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '2 days'),
    ('aaaaaaaa-0000-4000-a000-000000000024', '88888888-0000-4000-a000-000000000002',
     '55555555-0000-4000-a000-000000000005', 'registered', 'player', 11, '{LW}', 'unknown', now() - interval '2 days'),
    ('aaaaaaaa-0000-4000-a000-000000000025', '88888888-0000-4000-a000-000000000002',
     '55555555-0000-4000-a000-000000000009', 'registered', 'player', 4, '{LB}', 'unknown', now() - interval '1 day'),
    ('aaaaaaaa-0000-4000-a000-000000000026', '88888888-0000-4000-a000-000000000002',
     '55555555-0000-4000-a000-000000000011', 'registered', 'player', 10, '{RW}', 'unknown', now() - interval '1 day'),

    ('aaaaaaaa-0000-4000-a000-000000000031', '88888888-0000-4000-a000-000000000004',
     '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'unknown', now() - interval '2 days'),
    ('aaaaaaaa-0000-4000-a000-000000000032', '88888888-0000-4000-a000-000000000004',
     '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '2 days'),
    ('aaaaaaaa-0000-4000-a000-000000000033', '88888888-0000-4000-a000-000000000004',
     '55555555-0000-4000-a000-000000000008', 'registered', 'player', 7, '{ST}', 'unknown', now() - interval '1 day'),
    ('aaaaaaaa-0000-4000-a000-000000000034', '88888888-0000-4000-a000-000000000004',
     '55555555-0000-4000-a000-000000000010', 'registered', 'player', 6, '{CB}', 'unknown', now() - interval '1 day'),
    ('aaaaaaaa-0000-4000-a000-000000000035', '88888888-0000-4000-a000-000000000004',
     '55555555-0000-4000-a000-000000000011', 'registered', 'player', 10, '{RW}', 'unknown', now() - interval '12 hours'),
    ('aaaaaaaa-0000-4000-a000-000000000036', '88888888-0000-4000-a000-000000000004',
     '55555555-0000-4000-a000-000000000012', 'registered', 'player', 15, '{CM}', 'unknown', now() - interval '12 hours'),

    ('aaaaaaaa-0000-4000-a000-000000000041', '88888888-0000-4000-a000-000000000005',
     '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'unknown', now() - interval '1 day'),
    ('aaaaaaaa-0000-4000-a000-000000000042', '88888888-0000-4000-a000-000000000005',
     '55555555-0000-4000-a000-000000000003', 'registered', 'keeper', 1, '{GK}', 'unknown', now() - interval '1 day'),
    ('aaaaaaaa-0000-4000-a000-000000000043', '88888888-0000-4000-a000-000000000005',
     '55555555-0000-4000-a000-000000000005', 'registered', 'player', 11, '{LW}', 'unknown', now() - interval '18 hours'),
    ('aaaaaaaa-0000-4000-a000-000000000044', '88888888-0000-4000-a000-000000000005',
     '55555555-0000-4000-a000-000000000009', 'registered', 'player', 4, '{LB}', 'unknown', now() - interval '18 hours'),
    ('aaaaaaaa-0000-4000-a000-000000000045', '88888888-0000-4000-a000-000000000005',
     '55555555-0000-4000-a000-000000000010', 'registered', 'player', 6, '{CB}', 'unknown', now() - interval '12 hours'),
    ('aaaaaaaa-0000-4000-a000-000000000046', '88888888-0000-4000-a000-000000000005',
     '55555555-0000-4000-a000-000000000012', 'registered', 'player', 15, '{CM}', 'unknown', now() - interval '12 hours'),

    -- the past pickup is played; check-in and actual finalization follow
    ('aaaaaaaa-0000-4000-a000-000000000011', '88888888-0000-4000-a000-000000000003',
     '55555555-0000-4000-a000-000000000001', 'registered', 'player', 8, '{CM}', 'present', now() - interval '10 days'),
    ('aaaaaaaa-0000-4000-a000-000000000012', '88888888-0000-4000-a000-000000000003',
     '55555555-0000-4000-a000-000000000002', 'registered', 'player', 9, '{ST}', 'present', now() - interval '10 days'),
    ('aaaaaaaa-0000-4000-a000-000000000013', '88888888-0000-4000-a000-000000000003',
     '55555555-0000-4000-a000-000000000007', 'registered', 'player', 14, '{CM}', 'present', now() - interval '9 days'),
    -- registered and did not turn up
    ('aaaaaaaa-0000-4000-a000-000000000014', '88888888-0000-4000-a000-000000000003',
     '55555555-0000-4000-a000-000000000006', 'registered', 'player', 2, '{RB}', 'unknown', now() - interval '9 days'),
    -- cancelled in time, so owes nothing
    ('aaaaaaaa-0000-4000-a000-000000000015', '88888888-0000-4000-a000-000000000003',
     '55555555-0000-4000-a000-000000000004', 'cancelled', 'player', 5, '{CB}', 'unknown', now() - interval '11 days');

  -- Check-in occurs while the past game is completed, before its real finalization.
  -- Whole-seed reruns return before reaching this update.
  update public.game_registrations
  set checked_in_at = (anchor_date - 7 + time '08:50') at time zone 'America/Los_Angeles',
      checked_in_by = '11111111-0000-4000-a000-000000000001'
  where id in (
    'aaaaaaaa-0000-4000-a000-000000000011',
    'aaaaaaaa-0000-4000-a000-000000000012',
    'aaaaaaaa-0000-4000-a000-000000000013'
  )
  and checked_in_at is null;

  -- ------------------------------------------------------------------- money
  insert into public.fee_schedules (id, name, game_type, amount, effective_from) values
    ('bbbbbbbb-0000-4000-a000-000000000001', 'Pickup, standard', 'pickup', 10.00,
     (anchor_date - interval '1 year')::date),
    ('bbbbbbbb-0000-4000-a000-000000000002', 'Cup fixture, standard', 'cup', 25.00,
     (anchor_date - interval '1 year')::date);

  insert into public.billing_periods (id, label, start_date, end_date, status) values
    ('cccccccc-0000-4000-a000-000000000001',
     'Demo ' || to_char(past_date, 'YYYY') || '-Q' || to_char(past_date, 'Q'),
     date_trunc('quarter', past_date)::date,
     (date_trunc('quarter', past_date) + interval '3 months' - interval '1 day')::date,
     'open');

  -- Generate actual automatic fees; never fabricate charges or insert a locked game.
  perform public.finalise_game_attendance_internal('88888888-0000-4000-a000-000000000003');

  -- Ada has paid, Ben has not: one member square, one owing.
  insert into public.payments
    (id, account_id, amount, method, payment_date, external_ref, note)
  values
    ('eeeeeeee-0000-4000-a000-000000000001', '11111111-0000-4000-a000-000000000001',
     10.00, 'other', past_date, 'DEMO-PAYMENT-001', 'Synthetic payment, no real transfer');

  perform public.assign_to_periods();

  -- All assertions precede the LAST fixture write: the completion marker.
  fixture_counts := jsonb_build_object(
    'accounts', (SELECT count(*) FROM auth.users),
    'players', (SELECT count(*) FROM public.players),
    'clubs', (SELECT count(*) FROM public.clubs),
    'teams', (SELECT count(*) FROM public.teams),
    'venues', (SELECT count(*) FROM public.venues),
    'competitions', (SELECT count(*) FROM public.competitions),
    'games', (SELECT count(*) FROM public.games),
    'competition_registrations', (SELECT count(*) FROM public.competition_registrations),
    'game_registrations', (SELECT count(*) FROM public.game_registrations),
    'role_grants', (SELECT count(*) FROM public.role_grants),
    'fee_schedules', (SELECT count(*) FROM public.fee_schedules),
    'billing_periods', (SELECT count(*) FROM public.billing_periods),
    'charges', (SELECT count(*) FROM public.charges),
    'payments', (SELECT count(*) FROM public.payments));
  IF fixture_counts IS DISTINCT FROM expected_counts
     OR (SELECT count(*) FROM public.profiles) <> 6
     OR EXISTS (SELECT 1 FROM public.period_player_summaries)
     OR EXISTS (SELECT 1 FROM public.period_account_summaries)
     OR NOT EXISTS (SELECT 1 FROM public.audit_log) THEN
    RAISE EXCEPTION 'seed_fixture_counts_invalid' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM public.game_registrations
       WHERE game_id = '88888888-0000-4000-a000-000000000001'
         AND status = 'registered' AND participation IN ('player','keeper')) <> 4
     OR (SELECT count(*) FROM public.game_registrations
          WHERE game_id = '88888888-0000-4000-a000-000000000001' AND status = 'waitlisted') <> 2
     OR NOT EXISTS (SELECT 1 FROM public.games
                     WHERE id = '88888888-0000-4000-a000-000000000003'
                       AND status = 'locked' AND attendance_locked_at IS NOT NULL
                       AND game_date = past_date)
     OR (SELECT balance FROM public.v_account_balance
          WHERE account_id = '11111111-0000-4000-a000-000000000001') IS DISTINCT FROM 0::numeric
     OR (SELECT balance FROM public.v_account_balance
          WHERE account_id = '11111111-0000-4000-a000-000000000002') IS DISTINCT FROM 10::numeric
     OR NOT EXISTS (SELECT 1 FROM public.charges
                     WHERE player_id = '55555555-0000-4000-a000-000000000007'
                       AND account_id IS NULL AND amount = 10 AND source = 'auto')
     OR EXISTS (SELECT 1 FROM public.charges WHERE billing_period_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.payments WHERE billing_period_id IS NULL) THEN
    RAISE EXCEPTION 'seed_demo_scenarios_invalid' USING ERRCODE = '23514';
  END IF;

  -- LAST fixture DML: the marker and every preceding row commit together.
  -- A valid marker makes the next whole-seed run a read-only early return.
  UPDATE auth.users
     SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
           || jsonb_build_object('calblue_demo_seed', jsonb_build_object(
                'version', 1, 'status', 'complete', 'seed', 'calblue-demo',
                'anchor_date', anchor_date, 'installed_at', installed_at,
                'counts', expected_counts)),
         updated_at = installed_at
   WHERE id = '11111111-0000-4000-a000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seed_completion_marker_missing' USING ERRCODE = '23514';
  END IF;
  RAISE NOTICE 'CalBlue demo seed v1 installed atomically. Accounts are synthetic, not browser logins.';
END;
$seed$;
COMMIT;

-- Expected first-install state:
-- 6 accounts/profiles, 12 identities (6 without an account), 8 public identities.
-- 1 CalBlue demo club/default team, 2 invented venues, 1 Demo Cup with 3 fixtures.
-- Upcoming pickup: capacity 4, 4 registered, 2 waiting. Past pickup: locked via
-- actual finalization, 3 present, 1 no-show and 1 cancelled; 3 actual auto fees.
-- Ada paid 10/balance 0; Ben unpaid/balance 10; Grace guest unpaid 10/no payer yet.
-- Eve is Hugo's guardian/payer; Chen is player+treasurer, not admin; Dara has
-- only a scoped Demo Cup organiser grant. Finn has a pending roster request.
-- Verify/save a read-only fingerprint, rerun the entire confirmed seed, then
-- verify again: fixtures, relative dates, manual edits and audit must not change.
