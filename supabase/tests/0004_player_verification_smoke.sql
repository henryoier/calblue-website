-- Owner-run ONLY on an empty disposable project with 0001 through 0004 installed.
-- Synthetic role/JWT simulation, not real Auth/PostgREST or concurrency testing.
-- All fixture rows, temporary helpers and temporary grants roll back.
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT set_config('request.jwt.claims', '{}', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', '', true);

CREATE FUNCTION pg_temp.verification_id(n integer) RETURNS uuid
LANGUAGE sql SECURITY INVOKER AS $$
  SELECT ('c0320000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
CREATE FUNCTION pg_temp.verification_assert(ok boolean, label text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Verification smoke failed: %', label; END IF;
END $$;
CREATE FUNCTION pg_temp.verification_error(statement text, expected_state text, expected_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actual_state text; actual_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE, actual_message=MESSAGE_TEXT;
    IF actual_state <> expected_state OR (expected_message IS NOT NULL AND actual_message <> expected_message) THEN
      RAISE EXCEPTION 'Verification smoke expected % / %, received % / %',
        expected_state, expected_message, actual_state, actual_message;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Verification smoke expected an error: %', expected_state;
END $$;

DO $$
DECLARE relation_name text; n bigint;
BEGIN
  PERFORM pg_temp.verification_assert(current_user = pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.players'::regclass)), 'table owner session');
  PERFORM pg_temp.verification_assert(NOT EXISTS (SELECT 1 FROM auth.users), 'empty scratch Auth users');
  FOREACH relation_name IN ARRAY ARRAY['profiles','players','venues','clubs','teams','competitions','games',
    'role_grants','competition_registrations','game_registrations','fee_schedules','billing_periods',
    'charges','payments','period_player_summaries','period_account_summaries','audit_log'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', relation_name) INTO n;
    PERFORM pg_temp.verification_assert(n=0, 'empty scratch ' || relation_name);
  END LOOP;
  PERFORM pg_temp.verification_assert(to_regprocedure('public.list_player_verifications(text,integer)') IS NOT NULL,
    '0004 queue helper exists');
  PERFORM pg_temp.verification_assert(NOT has_function_privilege('anon',
    'public.list_player_verifications(text,integer)','EXECUTE'), 'anonymous queue execution revoked');
  PERFORM pg_temp.verification_assert(NOT has_function_privilege('authenticated',
    'public.guard_player_verification_decision()','EXECUTE'), 'trigger helper remains private');
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated',
    (SELECT nspname FROM pg_catalog.pg_namespace WHERE oid=pg_my_temp_schema()));
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.verification_id(integer), pg_temp.verification_assert(boolean,text),
  pg_temp.verification_error(text,text,text) TO anon, authenticated;
CREATE TEMP TABLE verification_decisions(player_id uuid, reviewer uuid, decided_at timestamptz) ON COMMIT DROP;
GRANT SELECT, INSERT ON TABLE pg_temp.verification_decisions TO authenticated;

INSERT INTO auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
SELECT pg_temp.verification_id(n), 'verification-' || n || '@example.invalid',
  '{}'::jsonb, '{"provider":"email"}'::jsonb, now(), now() FROM generate_series(101,103) n;
UPDATE public.profiles SET roles=ARRAY['admin'] WHERE id IN (pg_temp.verification_id(101),pg_temp.verification_id(103));
INSERT INTO public.players(id,account_id,guardian_account_id,display_name,legal_name,medical_notes,created_at)
SELECT pg_temp.verification_id(n), CASE WHEN n=201 THEN pg_temp.verification_id(102) END,
  CASE WHEN n=202 THEN pg_temp.verification_id(102) END,
  CASE WHEN n=205 THEN 'Literal %_ name' ELSE 'Synthetic ' || n END,
  CASE WHEN n=202 THEN 'Unique legal match' ELSE 'Legal ' || n END,
  'PRIVATE MEDICAL', timestamptz '2026-01-01 00:00:00+00' + n * interval '1 second'
FROM generate_series(201,255) n;
-- Represents a legacy rejection: no invented reviewer, timestamp or reason.
INSERT INTO public.players(id,guardian_account_id,display_name,verification_status)
VALUES(pg_temp.verification_id(256),pg_temp.verification_id(102),'Legacy rejected','rejected');

SET LOCAL ROLE anon;
SELECT pg_temp.verification_error('SELECT * FROM public.list_player_verifications()', '42501');
SELECT pg_temp.verification_error('SELECT * FROM public.decide_player_verifications(ARRAY[]::uuid[],ARRAY[]::timestamptz[],''verified'',NULL)', '42501');
RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"c0320000-0000-4000-8000-000000000102","role":"authenticated","app_metadata":{"roles":[]}}',true);
SET LOCAL ROLE authenticated;
-- RPC gates reject non-admins before argument/row-count handling.
SELECT pg_temp.verification_error('SELECT * FROM public.list_player_verifications(''no matches'')', '42501', 'verification_forbidden');
SELECT pg_temp.verification_error('SELECT * FROM public.decide_player_verifications(ARRAY[]::uuid[],ARRAY[]::timestamptz[],''verified'',NULL)', '42501', 'verification_forbidden');
SELECT pg_temp.verification_error('UPDATE public.players SET verification_status=''verified'' WHERE id=pg_temp.verification_id(201)', '42501');
SELECT pg_temp.verification_error('UPDATE public.players SET verification_note=''forged'' WHERE id=pg_temp.verification_id(202)', '42501');
SELECT pg_temp.verification_error('UPDATE public.players SET decided_by=pg_temp.verification_id(101),decided_at=now() WHERE id=pg_temp.verification_id(201)', '42501', 'verification_metadata_forbidden');
SELECT pg_temp.verification_error('INSERT INTO public.players(guardian_account_id,display_name,decided_by,decided_at) VALUES(pg_temp.verification_id(102),''Forged metadata'',pg_temp.verification_id(101),now())', '42501', 'verification_metadata_forbidden');
-- Direct clients cannot poison queue/version parsing with forged infinity.
INSERT INTO public.players(id,guardian_account_id,display_name,updated_at)
VALUES(pg_temp.verification_id(257),pg_temp.verification_id(102),'Finite version','infinity');
SELECT pg_temp.verification_assert((SELECT isfinite(updated_at) AND updated_at <= statement_timestamp()
  FROM public.players WHERE id=pg_temp.verification_id(257)), 'client insert timestamp normalized');
UPDATE public.players SET display_name='Legacy edited safely' WHERE id=pg_temp.verification_id(256);
SELECT pg_temp.verification_assert((SELECT verification_status='rejected' AND verification_note IS NULL
  AND decided_by IS NULL AND decided_at IS NULL FROM public.players WHERE id=pg_temp.verification_id(256)),
  'ordinary guardian edit preserves unknown legacy decision');
RESET ROLE;

-- Other global roles and malformed/admin-less claims remain non-admin.
SET LOCAL ROLE authenticated;
DO $$
DECLARE roles jsonb;
BEGIN
  FOREACH roles IN ARRAY ARRAY['["developer","treasurer","coach"]'::jsonb, '["ADMIN"]'::jsonb,
    '["admin",7]'::jsonb, '"admin"'::jsonb] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',pg_temp.verification_id(102),
      'role','authenticated','app_metadata',jsonb_build_object('roles',roles))::text,true);
    PERFORM pg_temp.verification_error('SELECT * FROM public.list_player_verifications()', '42501', 'verification_forbidden');
  END LOOP;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"c0320000-0000-4000-8000-000000000101","role":"authenticated","app_metadata":{"roles":["admin"]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.verification_assert((SELECT count(*)=51 FROM public.list_player_verifications()), 'first page capped at 51');
SELECT pg_temp.verification_assert((SELECT count(*)=6 FROM public.list_player_verifications('',50)), 'pagination with next-page row');
SELECT pg_temp.verification_assert((SELECT id=pg_temp.verification_id(257) FROM public.list_player_verifications() LIMIT 1), 'newest first');
SELECT pg_temp.verification_assert((SELECT count(*)=1 FROM public.list_player_verifications('%_')), 'literal wildcard characters');
SELECT pg_temp.verification_assert((SELECT count(*)=1 FROM public.list_player_verifications('UNIQUE LEGAL')), 'case-insensitive legal name search');
SELECT pg_temp.verification_assert((SELECT count(*)=1 FROM public.list_player_verifications('Legacy edited')), 'search includes terminal rows');
SELECT pg_temp.verification_assert(NOT EXISTS (SELECT 1 FROM public.list_player_verifications() q
  WHERE to_jsonb(q) ?| ARRAY['medical_notes','emergency_contact_name','account_id','guardian_account_id','date_of_birth','claim_code']), 'safe queue projection');
SELECT pg_temp.verification_error('SELECT * FROM public.list_player_verifications(repeat(''x'',101))','22023');
SELECT pg_temp.verification_error('SELECT * FROM public.list_player_verifications('''',-1)','22023');

DO $$
DECLARE ids uuid[] := ARRAY[pg_temp.verification_id(201),pg_temp.verification_id(202)];
  versions timestamptz[]; n integer;
BEGIN
  SELECT array_agg(p.updated_at ORDER BY wanted.ordinal) INTO versions
    FROM unnest(ids) WITH ORDINALITY wanted(player_id,ordinal) JOIN public.players p ON p.id=wanted.player_id;
  PERFORM pg_temp.verification_error(format('SELECT * FROM public.decide_player_verifications(%L::uuid[],%L::timestamptz[],''rejected'',E'' \n\t\r'')',ids,versions),'22023');
  PERFORM pg_temp.verification_error(format('SELECT * FROM public.decide_player_verifications(%L::uuid[],%L::timestamptz[],''verified'',%L)',ids,versions,repeat('x',1001)),'22023');
  PERFORM pg_temp.verification_error(format('SELECT * FROM public.decide_player_verifications(%L::uuid[],%L::timestamptz[],''verified'',NULL)',
    ARRAY[ids[1],ids[1]],versions),'22023');
  PERFORM pg_temp.verification_error(format('SELECT * FROM public.decide_player_verifications(%L::uuid[],%L::timestamptz[],''verified'',NULL)',
    ids,ARRAY[versions[1]-interval '1 microsecond',versions[2]]),'P0001','verification_conflict');
  SELECT count(*) INTO n FROM public.decide_player_verifications(ids,versions,'verified','  Reviewed  ');
  PERFORM pg_temp.verification_assert(n=2, 'atomic bulk approval returns both rows');
  PERFORM pg_temp.verification_assert((SELECT count(*)=2 FROM public.players WHERE id=ANY(ids)
    AND verification_status='verified' AND verification_note='Reviewed'
    AND decided_by=pg_temp.verification_id(101) AND decided_at IS NOT NULL), 'trusted reviewer/time persisted');
  INSERT INTO pg_temp.verification_decisions SELECT id,decided_by,decided_at FROM public.players WHERE id=ANY(ids);
  PERFORM pg_temp.verification_error(format('SELECT * FROM public.decide_player_verifications(%L::uuid[],%L::timestamptz[],''rejected'',''Changed mind'')',
    ids,versions),'P0001','verification_conflict');
END $$;

DO $$
DECLARE ids uuid[] := ARRAY[pg_temp.verification_id(203),pg_temp.verification_id(999)]; versions timestamptz[];
BEGIN
  SELECT ARRAY[updated_at,updated_at] INTO versions FROM public.players WHERE id=ids[1];
  PERFORM pg_temp.verification_error(format('SELECT * FROM public.decide_player_verifications(%L::uuid[],%L::timestamptz[],''verified'',NULL)',ids,versions),'P0001','verification_conflict');
  PERFORM pg_temp.verification_assert((SELECT verification_status='pending' FROM public.players WHERE id=ids[1]), 'missing batch member rolls back every decision');
END $$;
SELECT pg_temp.verification_error('UPDATE public.players SET verification_status=''rejected'',verification_note=E''\n\t'' WHERE id=pg_temp.verification_id(203)','22023');
SELECT pg_temp.verification_error('UPDATE public.players SET verification_status=''verified'',decided_by=pg_temp.verification_id(103),decided_at=now() WHERE id=pg_temp.verification_id(203)','42501','verification_metadata_forbidden');
UPDATE public.players SET verification_status='rejected',verification_note=E' \n Needs eligibility evidence \t'
WHERE id=pg_temp.verification_id(203);
SELECT pg_temp.verification_assert((SELECT verification_note='Needs eligibility evidence'
  AND decided_by=pg_temp.verification_id(101) AND decided_at IS NOT NULL FROM public.players WHERE id=pg_temp.verification_id(203)), 'direct admin rejection stamps and trims');
SELECT pg_temp.verification_error('UPDATE public.players SET verification_note=''Overwrite'' WHERE id=pg_temp.verification_id(203)','P0001','verification_conflict');
RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"c0320000-0000-4000-8000-000000000102","role":"authenticated","app_metadata":{"roles":[]}}',true);
SET LOCAL ROLE authenticated;
UPDATE public.players SET display_name='Still editable',medical_notes='PRIVATE UPDATED MEDICAL'
WHERE id IN (pg_temp.verification_id(201),pg_temp.verification_id(202));
SELECT pg_temp.verification_assert((SELECT count(*)=2 FROM public.players p
  JOIN pg_temp.verification_decisions saved ON saved.player_id=p.id
  WHERE p.decided_by=saved.reviewer AND p.decided_at=saved.decided_at
    AND p.verification_status='verified' AND p.verification_note='Reviewed'),
  'ordinary owner and guardian edits preserve decision metadata');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE '0004 player verification smoke passed; rolling back all fixtures.'; END $$;
ROLLBACK;
