-- Read-only verification of the freshly installed issue #28 demo dataset.
-- Run as postgres/database owner on the SAME DISPOSABLE project after seed.sql.
-- Run once before and once after repeating seed.sql; compare dataset_fingerprint.
-- All fixture assertions must pass and the fingerprints must match on an idle
-- project. After exploring/editing demo data, original-fixture assertions may
-- legitimately fail; this is not a reset or repair script.
-- Source-reviewed only: the coding agent has not executed this against PostgreSQL.

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','',true);

DO $$
DECLARE marker jsonb; relation_name text; expected_count text; actual_count bigint;
  expected jsonb := '{"auth.users":6,"public.profiles":6,"public.players":12,
    "public.clubs":1,"public.teams":1,"public.venues":2,"public.competitions":1,
    "public.games":5,"public.role_grants":1,"public.competition_registrations":10,
    "public.game_registrations":29,"public.fee_schedules":2,"public.billing_periods":1,
    "public.charges":3,"public.payments":1,"public.period_player_summaries":0,
    "public.period_account_summaries":0}'::jsonb;
BEGIN
  IF current_user <> pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.profiles'::regclass)) THEN
    RAISE EXCEPTION 'seed verification requires the application table owner';
  END IF;
  SELECT raw_app_meta_data->'calblue_demo_seed' INTO marker FROM auth.users
  WHERE id='11111111-0000-4000-a000-000000000001';
  IF marker->>'seed' IS DISTINCT FROM 'calblue-demo'
     OR marker->>'version' IS DISTINCT FROM '1'
     OR marker->>'status' IS DISTINCT FROM 'complete'
     OR marker->>'installed_at' IS NULL OR marker->>'anchor_date' IS NULL THEN
    RAISE EXCEPTION 'seed verification: completed version 1 marker missing';
  END IF;
  FOR relation_name, expected_count IN SELECT * FROM jsonb_each_text(expected) LOOP
    -- Identifiers are from the literal allowlist above, never user input.
    EXECUTE format('SELECT count(*) FROM %s', relation_name::regclass) INTO actual_count;
    IF actual_count <> expected_count::bigint THEN
      RAISE EXCEPTION 'seed verification: % expected % rows, found %', relation_name, expected_count, actual_count;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email NOT LIKE '%@example.com') THEN
    RAISE EXCEPTION 'seed verification: unexpected non-example account';
  END IF;
  IF (SELECT count(*) FROM public.players WHERE account_id IS NULL) <> 6
     OR (SELECT count(*) FROM public.players WHERE account_id IS NULL AND guardian_account_id IS NULL) <> 5 THEN
    RAISE EXCEPTION 'seed verification: guest/guardian identity mix differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players
    WHERE id='55555555-0000-4000-a000-000000000008' AND account_id IS NULL
      AND guardian_account_id='11111111-0000-4000-a000-000000000005'
      AND payer_account_id=guardian_account_id) THEN
    RAISE EXCEPTION 'seed verification: child payer is not the guardian';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
    WHERE id='11111111-0000-4000-a000-000000000003' AND roles=ARRAY['player','treasurer'])
    OR NOT EXISTS (SELECT 1 FROM public.profiles
    WHERE id='11111111-0000-4000-a000-000000000004' AND cardinality(roles)=0) THEN
    RAISE EXCEPTION 'seed verification: additive/scoped-only roles differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.role_grants
    WHERE account_id='11111111-0000-4000-a000-000000000004' AND role='organiser'
      AND competition_id='77777777-0000-4000-a000-000000000001') THEN
    RAISE EXCEPTION 'seed verification: scoped organiser missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE is_us)
     OR NOT EXISTS (SELECT 1 FROM public.teams WHERE is_default) THEN
    RAISE EXCEPTION 'seed verification: default CalBlue club/team missing';
  END IF;
  IF (SELECT count(*) FROM public.games
      WHERE competition_id='77777777-0000-4000-a000-000000000001' AND status='published') <> 3 THEN
    RAISE EXCEPTION 'seed verification: expected three published competition fixtures';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.games WHERE id='88888888-0000-4000-a000-000000000001'
    AND status='published' AND capacity=4 AND game_date=(marker->>'anchor_date')::date+7) THEN
    RAISE EXCEPTION 'seed verification: upcoming pickup anchor/capacity differs';
  END IF;
  IF (SELECT count(*) FROM public.game_registrations
      WHERE game_id='88888888-0000-4000-a000-000000000001'
        AND status='registered' AND participation IN ('player','keeper')) <> 4
     OR (SELECT count(*) FROM public.game_registrations
      WHERE game_id='88888888-0000-4000-a000-000000000001' AND status='waitlisted') <> 2 THEN
    RAISE EXCEPTION 'seed verification: pickup should be full with two waiting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.games
    WHERE id='88888888-0000-4000-a000-000000000003' AND status='locked'
      AND attendance_locked_at IS NOT NULL AND game_date=(marker->>'anchor_date')::date-7) THEN
    RAISE EXCEPTION 'seed verification: past pickup was not finalized at the expected date';
  END IF;
  IF (SELECT count(*) FROM public.game_registrations WHERE game_id='88888888-0000-4000-a000-000000000003'
      AND attendance='present') <> 3
     OR (SELECT count(*) FROM public.game_registrations WHERE game_id='88888888-0000-4000-a000-000000000003'
      AND attendance='absent') <> 1
     OR (SELECT count(*) FROM public.game_registrations WHERE game_id='88888888-0000-4000-a000-000000000003'
      AND status='cancelled') <> 1 THEN
    RAISE EXCEPTION 'seed verification: completed attendance cases differ';
  END IF;
  IF (SELECT count(*) FROM public.charges WHERE game_id='88888888-0000-4000-a000-000000000003'
      AND source='auto' AND kind='game_fee' AND amount=10 AND voided_at IS NULL) <> 3 THEN
    RAISE EXCEPTION 'seed verification: expected three generated 10-unit game fees';
  END IF;
  IF (SELECT count(*) FROM public.charges WHERE account_id IS NULL AND amount=10) <> 1 THEN
    RAISE EXCEPTION 'seed verification: unclaimed guest charge missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.v_account_balance
      WHERE account_id='11111111-0000-4000-a000-000000000001' AND balance=0)
     OR NOT EXISTS (SELECT 1 FROM public.v_account_balance
      WHERE account_id='11111111-0000-4000-a000-000000000002' AND balance=10) THEN
    RAISE EXCEPTION 'seed verification: paid/unpaid account balances differ';
  END IF;
  IF EXISTS (SELECT 1 FROM public.charges ch LEFT JOIN public.billing_periods p ON p.id=ch.billing_period_id
    WHERE p.id IS NULL OR p.status<>'open' OR ch.charge_date NOT BETWEEN p.start_date AND p.end_date)
     OR EXISTS (SELECT 1 FROM public.payments pay LEFT JOIN public.billing_periods p ON p.id=pay.billing_period_id
    WHERE p.id IS NULL OR p.status<>'open' OR pay.payment_date NOT BETWEEN p.start_date AND p.end_date) THEN
    RAISE EXCEPTION 'seed verification: financial dates must be assigned to the open period';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE verification_status='pending')
     OR NOT EXISTS (SELECT 1 FROM public.competition_registrations WHERE status='pending') THEN
    RAISE EXCEPTION 'seed verification: review queues should not be empty';
  END IF;
  IF EXISTS (SELECT 1 FROM public.game_registrations gr JOIN public.games g ON g.id=gr.game_id
    JOIN public.players p ON p.id=gr.player_id
    WHERE g.competition_id IS NOT NULL AND gr.status='registered'
      AND (p.verification_status<>'verified' OR NOT EXISTS (
        SELECT 1 FROM public.competition_registrations cr
        WHERE cr.competition_id=g.competition_id AND cr.player_id=p.id AND cr.status='approved'))) THEN
    RAISE EXCEPTION 'seed verification: competition selections must use approved, verified identities';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE table_name='charges') THEN
    RAISE EXCEPTION 'seed verification: real billing audit evidence missing';
  END IF;
END;
$$;

-- Known fixture accounts can exercise read paths without passwords, email or login.
-- These owner-set synthetic claims do not test Auth signing or a browser session.
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SET LOCAL ROLE anon;
DO $$
DECLARE denied boolean := false;
BEGIN
  IF (SELECT count(*) FROM public.v_public_roster) <> 8 THEN
    RAISE EXCEPTION 'seed verification: public roster should contain eight opted-in verified identities';
  END IF;
  BEGIN
    PERFORM 1 FROM public.profiles;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'seed verification: anonymous private profile read was allowed'; END IF;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claims','{"sub":"11111111-0000-4000-a000-000000000002","role":"authenticated","app_metadata":{"roles":["player"]}}',true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles) <> 1
     OR (SELECT count(*) FROM public.players) <> 1
     OR (SELECT count(*) FROM public.charges) <> 1
     OR (SELECT count(*) FROM public.payments) <> 0
     OR (SELECT count(*) FROM public.v_account_balance WHERE balance=10) <> 1 THEN
    RAISE EXCEPTION 'seed verification: unpaid member read isolation differs';
  END IF;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claims','{"sub":"11111111-0000-4000-a000-000000000004","role":"authenticated","app_metadata":{"roles":[]}}',true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.is_admin() IS NOT FALSE
     OR public.manages_game('88888888-0000-4000-a000-000000000002') IS NOT TRUE
     OR public.manages_game('88888888-0000-4000-a000-000000000001') IS NOT FALSE
     OR (SELECT count(*) FROM public.charges) <> 0 THEN
    RAISE EXCEPTION 'seed verification: scoped organiser permissions differ';
  END IF;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claims','{"sub":"11111111-0000-4000-a000-000000000005","role":"authenticated","app_metadata":{"roles":["player","coach"]}}',true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.players) <> 2
     OR public.owns_player('55555555-0000-4000-a000-000000000008') IS NOT TRUE THEN
    RAISE EXCEPTION 'seed verification: guardian should read own and child identities';
  END IF;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);

-- A comparison checksum, not a credential or an authorization mechanism.
-- Includes timestamps, marker/auth metadata, audit records and sequence state,
-- so a rerun that rewrites existing rows is detectable even if counts match.
SELECT md5(jsonb_build_object(
  'auth.users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM auth.users t),
  'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.profiles t),
  'players',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.players t),
  'clubs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.clubs t),
  'teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.teams t),
  'venues',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.venues t),
  'competitions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.competitions t),
  'games',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.games t),
  'role_grants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.role_grants t),
  'competition_registrations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.competition_registrations t),
  'game_registrations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.game_registrations t),
  'fee_schedules',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.fee_schedules t),
  'billing_periods',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.billing_periods t),
  'charges',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.charges t),
  'payments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.payments t),
  'period_player_summaries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.period_player_summaries t),
  'period_account_summaries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.period_account_summaries t),
  'audit_log',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_log t),
  'audit_sequence',(SELECT jsonb_build_object(
    'last_value',last_value,'log_cnt',log_cnt,'is_called',is_called)
    FROM public.audit_log_id_seq)
)::text) AS dataset_fingerprint,
  'Fixture and read-access assertions passed; compare this fingerprint across the seed rerun.'::text AS verification_result;
COMMIT;
