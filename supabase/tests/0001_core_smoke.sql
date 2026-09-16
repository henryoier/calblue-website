-- Manual smoke test for an EMPTY, DISPOSABLE Supabase project after 0001_core.sql only.
-- Run as the database owner (for example, the scratch project's SQL Editor), never in production.
-- With psql, use -v ON_ERROR_STOP=1 so the client stops at the first unexpected error.
-- All fixtures, grants, policies and temporary helpers are rolled back. No passwords or API keys.
-- This script has not been executed by the coding agent; source review is not database validation.
--
-- Single-session checks do NOT prove last-slot concurrency, concurrent cancellation/promotion,
-- or lock/deadlock behavior. Those still require two independent transactions on scratch data.
-- SKIP LOCKED is best-effort FIFO: a locked waiter can be skipped and a vacancy can remain until
-- a later operation. Do not interpret a passing smoke test as strict FIFO/concurrency proof.

BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = public, extensions;

CREATE FUNCTION pg_temp.core_assert(condition boolean, description text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'core smoke assertion failed: %', description;
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.core_id(number integer) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT ('c0250000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid;
$$;

-- An unexpectedly successful statement fails OUTSIDE the exception block, so it cannot be
-- mistaken for the expected failure. An unexpected SQLSTATE/message also aborts the whole test.
CREATE FUNCTION pg_temp.core_expect_error(statement text, expected_state text,
                                          expected_message text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE actual_state text; actual_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE, actual_message = MESSAGE_TEXT;
    IF actual_state <> expected_state
       OR (expected_message IS NOT NULL AND actual_message <> expected_message) THEN
      RAISE EXCEPTION 'core smoke expected SQLSTATE % / %, received % / %',
        expected_state, expected_message, actual_state, actual_message;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'core smoke expected SQLSTATE %, but statement succeeded', expected_state;
END;
$$;

DO $$
DECLARE
  table_name text; client_role text; privilege_name text; helper_name text;
  relation_id oid; helper_id oid; row_count bigint;
  core_tables text[] := ARRAY['profiles', 'players', 'venues', 'clubs', 'teams', 'competitions',
    'games', 'role_grants', 'competition_registrations', 'game_registrations'];
BEGIN
  FOREACH table_name IN ARRAY core_tables LOOP
    relation_id := to_regclass('public.' || table_name);
    PERFORM pg_temp.core_assert(relation_id IS NOT NULL, table_name || ' exists');
    PERFORM pg_temp.core_assert(
      (SELECT relrowsecurity FROM pg_class WHERE oid = relation_id), table_name || ' has RLS');
    PERFORM pg_temp.core_assert(
      NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = relation_id),
      table_name || ' has no policies before issue #27');
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                            'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        PERFORM pg_temp.core_assert(
          NOT has_table_privilege(client_role, relation_id, privilege_name),
          table_name || ': ' || client_role || ' has no ' || privilege_name || ' privilege');
      END LOOP;
    END LOOP;
    PERFORM pg_temp.core_assert(
      (SELECT count(*) = 2 FROM pg_attribute WHERE attrelid = relation_id
       AND attname IN ('created_at', 'updated_at') AND attnotnull AND NOT attisdropped),
      table_name || ' has required timestamps');
    PERFORM pg_temp.core_assert(
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = relation_id AND NOT tgisinternal
              AND tgfoid = 'public.touch_updated_at()'::regprocedure AND tgenabled IN ('O', 'A')),
      table_name || ' has an enabled touch trigger');
    EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_count;
    PERFORM pg_temp.core_assert(row_count = 0, 'scratch-only guard: ' || table_name || ' must be empty');
  END LOOP;

  FOREACH helper_name IN ARRAY ARRAY['touch_updated_at()', 'handle_new_user()', 'sync_role_claim()',
    'set_game_date()', 'enforce_game_capacity()', 'promote_from_waitlist(uuid)', 'on_slot_freed()'] LOOP
    helper_id := to_regprocedure('public.' || helper_name);
    PERFORM pg_temp.core_assert(helper_id IS NOT NULL, helper_name || ' exists');
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      PERFORM pg_temp.core_assert(NOT has_function_privilege(client_role, helper_id, 'EXECUTE'),
                                 helper_name || ' is not executable by ' || client_role);
    END LOOP;
    PERFORM pg_temp.core_assert(
      EXISTS (SELECT 1 FROM pg_proc, unnest(proconfig) AS config(setting)
              WHERE pg_proc.oid = helper_id AND setting IN ('search_path=', 'search_path=""')),
      helper_name || ' has a fixed empty search path');
    IF helper_name <> 'touch_updated_at()' THEN
      PERFORM pg_temp.core_assert((SELECT prosecdef FROM pg_proc WHERE oid = helper_id),
                                 helper_name || ' runs as its trusted owner');
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  fixture_number integer; table_name text; row_count bigint; updated_count bigint;
  account_a uuid := pg_temp.core_id(101); account_b uuid := pg_temp.core_id(102);
  account_c uuid := pg_temp.core_id(103);
  player_a uuid := pg_temp.core_id(201); player_b uuid := pg_temp.core_id(202);
  child uuid := pg_temp.core_id(203);
BEGIN
  -- Synthetic auth rows exercise the real bootstrap and role-metadata triggers without login/email.
  FOR fixture_number IN 101..103 LOOP
    INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
    VALUES (pg_temp.core_id(fixture_number), 'core-smoke-' || fixture_number || '@example.invalid',
            jsonb_build_object('display_name', 'Synthetic member ' || fixture_number),
            '{"provider":"email","fixture":"core-smoke"}'::jsonb, now(), now());
  END LOOP;
  PERFORM pg_temp.core_assert(
    (SELECT count(*) = 3 FROM public.profiles WHERE id IN (account_a, account_b, account_c)),
    'auth user creation bootstraps profiles');
  PERFORM pg_temp.core_assert(
    (SELECT display_name = 'Synthetic member 101' AND cardinality(roles) = 0
     FROM public.profiles WHERE id = account_a), 'bootstrap name and empty initial roles');
  UPDATE public.profiles SET roles = ARRAY['player', 'treasurer'] WHERE id = account_a;
  PERFORM pg_temp.core_assert(
    (SELECT raw_app_meta_data -> 'roles' = '["player","treasurer"]'::jsonb
            AND raw_app_meta_data ->> 'fixture' = 'core-smoke'
     FROM auth.users WHERE id = account_a), 'role changes mirror without deleting unrelated metadata');

  INSERT INTO public.players (id, account_id, guardian_account_id, display_name, updated_at) VALUES
    (player_a, account_a, NULL, 'Synthetic adult A', '2000-01-01 00:00:00+00'),
    (player_b, account_b, NULL, 'Synthetic adult B', '2000-01-01 00:00:00+00'),
    (child, NULL, account_a, 'Synthetic child', '2000-01-01 00:00:00+00');
  FOR fixture_number IN 204..210 LOOP
    INSERT INTO public.players (id, display_name, updated_at)
      VALUES (pg_temp.core_id(fixture_number), 'Synthetic guest ' || fixture_number, '2000-01-01 00:00:00+00');
  END LOOP;
  PERFORM pg_temp.core_expect_error(format(
    'INSERT INTO public.players (account_id, display_name) VALUES (%L, %L)', account_a, 'Duplicate'), '23505');
  PERFORM pg_temp.core_assert(
    (SELECT payer_account_id = account_a FROM public.players WHERE id = child), 'guardian pays for child');
  UPDATE public.players SET guardian_account_id = account_b, account_id = account_c WHERE id = child;
  PERFORM pg_temp.core_assert(
    (SELECT payer_account_id = account_c FROM public.players WHERE id = child), 'own account takes payer precedence');
  UPDATE public.players SET account_id = NULL WHERE id = child;
  PERFORM pg_temp.core_assert(
    (SELECT payer_account_id = account_b FROM public.players WHERE id = child), 'generated payer follows guardian changes');
  PERFORM pg_temp.core_assert(
    (SELECT count(*) = 7 FROM public.players WHERE account_id IS NULL AND guardian_account_id IS NULL),
    'multiple unclaimed guest identities are allowed');
  PERFORM pg_temp.core_expect_error(format(
    'UPDATE public.players SET payer_account_id = %L WHERE id = %L', account_a, child), '428C9');

  INSERT INTO public.clubs (id, name, updated_at) VALUES
    (pg_temp.core_id(501), 'Synthetic club', '2000-01-01 00:00:00+00'),
    (pg_temp.core_id(502), 'Synthetic removable club', '2000-01-01 00:00:00+00');
  -- The FK is defined AFTER clubs exists; it is not a DEFERRABLE constraint.
  UPDATE public.players SET home_club_id = pg_temp.core_id(502) WHERE id = child;
  PERFORM pg_temp.core_assert(
    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_home_club_id_fkey'
            AND conrelid = 'public.players'::regclass AND confrelid = 'public.clubs'::regclass
            AND convalidated), 'deferred-definition club FK is installed and validated');
  PERFORM pg_temp.core_expect_error(format(
    'UPDATE public.players SET home_club_id = %L WHERE id = %L', pg_temp.core_id(599), child), '23503');
  DELETE FROM public.clubs WHERE id = pg_temp.core_id(502);
  PERFORM pg_temp.core_assert(
    (SELECT home_club_id IS NULL FROM public.players WHERE id = child), 'club deletion clears player reference');
  INSERT INTO public.teams (id, club_id, name, updated_at)
    VALUES (pg_temp.core_id(601), pg_temp.core_id(501), 'Synthetic team', '2000-01-01 00:00:00+00');
  INSERT INTO public.competitions (id, name, kind, updated_at)
    VALUES (pg_temp.core_id(701), 'Synthetic competition', 'league', '2000-01-01 00:00:00+00');
  INSERT INTO public.venues (id, name, timezone, updated_at) VALUES
    (pg_temp.core_id(401), 'Synthetic Pacific venue', 'America/Los_Angeles', '2000-01-01 00:00:00+00'),
    (pg_temp.core_id(402), 'Synthetic Tokyo venue', 'Asia/Tokyo', '2000-01-01 00:00:00+00');

  INSERT INTO public.games (id, title, game_type, venue_id, timezone, start_time, game_date, updated_at)
    VALUES (pg_temp.core_id(800), 'Date fixture', 'pickup', pg_temp.core_id(401), 'UTC',
            '2030-01-01 00:30:00+00', '2099-01-01', '2000-01-01 00:00:00+00');
  PERFORM pg_temp.core_assert(
    (SELECT game_date = DATE '2029-12-31' AND timezone = 'America/Los_Angeles'
     FROM public.games WHERE id = pg_temp.core_id(800)), 'venue timezone controls date on insert');
  UPDATE public.games SET game_date = '2099-01-01', timezone = 'UTC' WHERE id = pg_temp.core_id(800);
  PERFORM pg_temp.core_assert(
    (SELECT game_date = DATE '2029-12-31' FROM public.games WHERE id = pg_temp.core_id(800)),
    'direct game_date overwrite is replaced by derivation');
  UPDATE public.games SET venue_id = pg_temp.core_id(402) WHERE id = pg_temp.core_id(800);
  PERFORM pg_temp.core_assert(
    (SELECT game_date = DATE '2030-01-01' AND timezone = 'Asia/Tokyo'
     FROM public.games WHERE id = pg_temp.core_id(800)), 'changing venue changes authoritative timezone');
  UPDATE public.games SET venue_id = NULL, timezone = 'America/Los_Angeles' WHERE id = pg_temp.core_id(800);
  PERFORM pg_temp.core_assert(
    (SELECT game_date = DATE '2029-12-31' FROM public.games WHERE id = pg_temp.core_id(800)),
    'venue-less game uses its own timezone');

  FOR fixture_number IN 801..808 LOOP
    INSERT INTO public.games (id, title, game_type, start_time, capacity, status, updated_at)
      VALUES (pg_temp.core_id(fixture_number), 'Capacity fixture ' || fixture_number, 'pickup',
              '2030-01-02 18:00:00+00', CASE WHEN fixture_number = 801 THEN 2 ELSE 1 END,
              'published', '2000-01-01 00:00:00+00');
  END LOOP;
  INSERT INTO public.games (id, title, game_type, start_time, capacity, status, updated_at)
    VALUES (pg_temp.core_id(901), 'Hidden capacity fixture', 'pickup', '2030-01-02 18:00:00+00',
            1, 'published', '2000-01-01 00:00:00+00');
  INSERT INTO public.role_grants (id, account_id, role, game_id, updated_at)
    VALUES (pg_temp.core_id(750), account_a, 'captain', pg_temp.core_id(801), '2000-01-01 00:00:00+00');
  PERFORM pg_temp.core_expect_error(format(
    'INSERT INTO public.role_grants (account_id, role) VALUES (%L, %L)', account_a, 'captain'), '23514');
  PERFORM pg_temp.core_expect_error(format(
    'INSERT INTO public.role_grants (account_id, role, game_id, team_id) VALUES (%L, %L, %L, %L)',
    account_a, 'captain', pg_temp.core_id(801), pg_temp.core_id(601)), '23514');
  INSERT INTO public.competition_registrations
    (competition_id, player_id, status, jersey_number, updated_at) VALUES
    (pg_temp.core_id(701), player_a, 'approved', 7, '2000-01-01 00:00:00+00'),
    (pg_temp.core_id(701), player_b, 'pending', 7, '2000-01-01 00:00:00+00');
  PERFORM pg_temp.core_expect_error(format(
    'UPDATE public.competition_registrations SET status = %L WHERE player_id = %L', 'approved', player_b), '23505');

  INSERT INTO public.game_registrations (id, game_id, player_id, participation, updated_at) VALUES
    (pg_temp.core_id(1001), pg_temp.core_id(801), player_a, 'player', '2000-01-01 00:00:00+00'),
    (pg_temp.core_id(1002), pg_temp.core_id(801), player_b, 'keeper', '2000-01-01 00:00:00+00'),
    (pg_temp.core_id(1003), pg_temp.core_id(801), child, 'coach', '2000-01-01 00:00:00+00'),
    (pg_temp.core_id(1004), pg_temp.core_id(801), pg_temp.core_id(204), 'volunteer', '2000-01-01 00:00:00+00');
  PERFORM pg_temp.core_expect_error(format(
    'INSERT INTO public.game_registrations (game_id, player_id) VALUES (%L, %L)',
    pg_temp.core_id(801), pg_temp.core_id(205)), '23514', 'game_full');
  PERFORM pg_temp.core_expect_error(format(
    'INSERT INTO public.game_registrations (game_id, player_id) VALUES (%L, %L)',
    pg_temp.core_id(801), player_a), '23505');
  INSERT INTO public.game_registrations (id, game_id, player_id, jersey_number)
    VALUES (pg_temp.core_id(1099), pg_temp.core_id(801), player_a, 17)
    ON CONFLICT (game_id, player_id) DO UPDATE SET jersey_number = excluded.jersey_number;
  PERFORM pg_temp.core_assert(
    (SELECT count(*) = 1 AND bool_and(id = pg_temp.core_id(1001) AND jersey_number = 17)
     FROM public.game_registrations WHERE game_id = pg_temp.core_id(801) AND player_id = player_a),
    'same-player upsert at capacity preserves one seat and the original identity');
  PERFORM pg_temp.core_assert(
    (SELECT count(*) = 2 FROM public.game_registrations WHERE game_id = pg_temp.core_id(801)
     AND status = 'registered' AND participation IN ('player', 'keeper')),
    'players and keepers count; coaches and volunteers do not');
  FOREACH table_name IN ARRAY ARRAY['id', 'game_id', 'player_id'] LOOP
    PERFORM pg_temp.core_expect_error(format(
      'UPDATE public.game_registrations SET %I = %L WHERE id = %L', table_name,
      CASE table_name WHEN 'id' THEN pg_temp.core_id(1098) WHEN 'game_id' THEN pg_temp.core_id(802)
                      ELSE pg_temp.core_id(209) END, pg_temp.core_id(1001)),
      '23514', 'registration_identity_is_immutable');
  END LOOP;

  -- Identical two-person queues exercise cancellation, participation change and deletion.
  FOR fixture_number IN 802..804 LOOP
    INSERT INTO public.game_registrations (id, game_id, player_id, status, participation, updated_at) VALUES
      (pg_temp.core_id(fixture_number * 10), pg_temp.core_id(fixture_number), player_a,
       'registered', 'keeper', '2000-01-01 00:00:00+00'),
      (pg_temp.core_id(fixture_number * 10 + 1), pg_temp.core_id(fixture_number), player_b,
       'waitlisted', 'player', '2000-01-01 00:00:00+00');
  END LOOP;
  UPDATE public.game_registrations SET status = 'cancelled' WHERE id = pg_temp.core_id(8020);
  UPDATE public.game_registrations SET participation = 'coach' WHERE id = pg_temp.core_id(8030);
  DELETE FROM public.game_registrations WHERE id = pg_temp.core_id(8040);
  PERFORM pg_temp.core_assert(
    (SELECT count(*) = 3 FROM public.game_registrations
     WHERE id IN (pg_temp.core_id(8021), pg_temp.core_id(8031), pg_temp.core_id(8041))
       AND status = 'registered'), 'all three counted-slot release paths promote a waiter');

  -- Earlier nonplaying waiters must be skipped; equal-time player/keeper waiters use UUID order.
  INSERT INTO public.game_registrations (id, game_id, player_id, status, participation, registered_at) VALUES
    (pg_temp.core_id(8050), pg_temp.core_id(805), player_a, 'registered', 'player', '2029-01-01 00:00:00+00'),
    (pg_temp.core_id(8051), pg_temp.core_id(805), child, 'waitlisted', 'coach', '2028-01-01 00:00:00+00'),
    (pg_temp.core_id(8052), pg_temp.core_id(805), pg_temp.core_id(204), 'waitlisted', 'volunteer', '2028-01-01 00:00:00+00'),
    (pg_temp.core_id(8054), pg_temp.core_id(805), pg_temp.core_id(205), 'waitlisted', 'keeper', '2029-01-01 00:00:00+00'),
    (pg_temp.core_id(8053), pg_temp.core_id(805), player_b, 'waitlisted', 'player', '2029-01-01 00:00:00+00');
  UPDATE public.game_registrations SET status = 'cancelled' WHERE id = pg_temp.core_id(8050);
  PERFORM pg_temp.core_assert(
    (SELECT status = 'registered' FROM public.game_registrations WHERE id = pg_temp.core_id(8053)),
    'eligible tied waiter with lower UUID wins even when inserted later');
  PERFORM pg_temp.core_assert(
    (SELECT count(*) = 3 FROM public.game_registrations
     WHERE id IN (pg_temp.core_id(8051), pg_temp.core_id(8052), pg_temp.core_id(8054))
       AND status = 'waitlisted'), 'nonplaying waiters stay queued and only one slot is filled');
  UPDATE public.game_registrations SET status = 'cancelled' WHERE id = pg_temp.core_id(8053);
  PERFORM pg_temp.core_assert(
    (SELECT status = 'registered' FROM public.game_registrations WHERE id = pg_temp.core_id(8054)),
    'keeper takes the next released slot');

  FOR fixture_number IN 806..808 LOOP
    INSERT INTO public.game_registrations (id, game_id, player_id, status) VALUES
      (pg_temp.core_id(fixture_number * 10), pg_temp.core_id(fixture_number), player_a, 'registered'),
      (pg_temp.core_id(fixture_number * 10 + 1), pg_temp.core_id(fixture_number), player_b, 'waitlisted');
    UPDATE public.games SET status = CASE fixture_number WHEN 806 THEN 'cancelled'
                                                        WHEN 807 THEN 'locked' ELSE 'published' END,
                            waitlist_enabled = fixture_number <> 808
      WHERE id = pg_temp.core_id(fixture_number);
    UPDATE public.game_registrations SET status = 'cancelled' WHERE id = pg_temp.core_id(fixture_number * 10);
    PERFORM pg_temp.core_assert(
      (SELECT status = 'waitlisted' FROM public.game_registrations
       WHERE id = pg_temp.core_id(fixture_number * 10 + 1)), 'closed/disabled queue does not auto-promote');
  END LOOP;

  INSERT INTO public.game_registrations (id, game_id, player_id, registered_by)
    VALUES (pg_temp.core_id(9010), pg_temp.core_id(901), player_a, account_a);

  -- now() is transaction-stable: explicitly write an old value and require the touch trigger
  -- to override it, rather than sleeping or comparing two now() values in this transaction.
  FOREACH table_name IN ARRAY ARRAY['profiles', 'players', 'venues', 'clubs', 'teams', 'competitions',
                                   'games', 'role_grants', 'competition_registrations', 'game_registrations'] LOOP
    EXECUTE format('UPDATE public.%I SET updated_at = %L::timestamptz', table_name, '2000-01-01 00:00:00+00');
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE updated_at = now()) FROM public.%I', table_name)
      INTO row_count, updated_count;
    PERFORM pg_temp.core_assert(row_count > 0 AND row_count = updated_count, table_name || ' touch works');
  END LOOP;
END;
$$;

-- Temporary test-only privileges/policies. Production remains fail-closed after ROLLBACK.
GRANT SELECT, INSERT ON public.game_registrations TO authenticated;
CREATE POLICY core_smoke_member_read ON public.game_registrations FOR SELECT TO authenticated
  USING (player_id = 'c0250000-0000-4000-8000-000000000202'::uuid AND registered_by = auth.uid());
CREATE POLICY core_smoke_member_insert ON public.game_registrations FOR INSERT TO authenticated
  WITH CHECK (player_id = 'c0250000-0000-4000-8000-000000000202'::uuid AND registered_by = auth.uid());
SELECT set_config('request.jwt.claim.sub', 'c0250000-0000-4000-8000-000000000102', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"c0250000-0000-4000-8000-000000000102","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE blocked boolean := false; helper_denied boolean := false;
BEGIN
  IF (SELECT count(*) FROM public.game_registrations
      WHERE game_id = 'c0250000-0000-4000-8000-000000000901'::uuid) <> 0 THEN
    RAISE EXCEPTION 'core smoke: restrictive member policy did not hide the occupied seat';
  END IF;
  BEGIN
    INSERT INTO public.game_registrations (id, game_id, player_id, registered_by) VALUES
      ('c0250000-0000-4000-8000-000000009011', 'c0250000-0000-4000-8000-000000000901',
       'c0250000-0000-4000-8000-000000000202', 'c0250000-0000-4000-8000-000000000102');
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'game_full' THEN RAISE; END IF;
    blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'core smoke: hidden occupied seat was not counted'; END IF;
  BEGIN
    PERFORM public.promote_from_waitlist('c0250000-0000-4000-8000-000000000901'::uuid);
  EXCEPTION WHEN insufficient_privilege THEN
    helper_denied := true;
  END;
  IF NOT helper_denied THEN RAISE EXCEPTION 'core smoke: authenticated could execute internal helper'; END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  PERFORM pg_temp.core_assert(
    (SELECT count(*) = 1 FROM public.game_registrations WHERE game_id = pg_temp.core_id(901)),
    'failed member insert left the original seat intact');
  RAISE NOTICE 'Core single-session smoke assertions passed; rolling back all test changes. Two-session concurrency remains unverified.';
END;
$$;
ROLLBACK;
-- Intentionally no success statement after ROLLBACK: it could conceal an earlier aborted test.
