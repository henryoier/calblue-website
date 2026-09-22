-- Owner-run ONLY on an idle disposable project with 0001–0005 installed.
-- Allowed: empty, or exactly one confirmed admin Auth/profile bootstrap account
-- and only its profile-update audit history. ALL business tables must be empty.
-- Synthetic claims/roles, not real Auth/PostgREST or concurrent-session testing.
-- Run the WHOLE script through ROLLBACK. Rows/helpers/grants roll back; audit
-- identity sequence advancement does not. Never run on a member-data project.
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','',true);

CREATE FUNCTION pg_temp.pickup_id(n integer) RETURNS uuid LANGUAGE sql SECURITY INVOKER AS $$
  SELECT ('c0330000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
CREATE FUNCTION pg_temp.pickup_assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Pickup smoke failed: %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.pickup_error(statement text,expected_state text,expected_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actual_state text; actual_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_message=MESSAGE_TEXT;
    IF actual_state <> expected_state OR (expected_message IS NOT NULL AND actual_message <> expected_message) THEN
      RAISE EXCEPTION 'Pickup smoke expected % / %, received % / %',
        expected_state,expected_message,actual_state,actual_message;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Pickup smoke expected an error: %',expected_state;
END $$;
CREATE FUNCTION pg_temp.pickup_claim(n integer,roles jsonb DEFAULT '[]') RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.pickup_id(n),
    'role','authenticated','app_metadata',jsonb_build_object('roles',roles))::text,true);
END;
$$;
CREATE FUNCTION pg_temp.pickup_details(team uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER AS $$
  SELECT jsonb_build_object('team_id',team,'venue_id',NULL,'title','Synthetic pickup',
    'field_label',NULL,'timezone','UTC','gather_time',NULL,
    'start_time',to_char((date_trunc('day',statement_timestamp() AT TIME ZONE 'UTC') + interval '35 days 4 hours'),
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'),'end_time',NULL,'capacity',2,
    'registration_opens_at',NULL,'registration_closes_at',NULL,'kit_color',NULL,'notes',NULL)
$$;

-- Owner-only baseline; neither identifiers nor fingerprints are printed or
-- granted to the simulated API roles. No passwords/tokens are read.
CREATE TEMP TABLE pickup_baseline(account_id uuid,auth_fingerprint text,profile_fingerprint text,
  audit_ids bigint[],audit_fingerprint text) ON COMMIT DROP;
REVOKE ALL ON TABLE pg_temp.pickup_baseline FROM PUBLIC,anon,authenticated;
DO $$
DECLARE relation_name text; n bigint; retained_account uuid;
BEGIN
  PERFORM pg_temp.pickup_assert(current_user='postgres' AND current_user = pg_catalog.pg_get_userbyid(
    (SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.games'::regclass)), 'table owner session');
  PERFORM pg_temp.pickup_assert((SELECT count(*) FROM auth.users) IN (0,1), 'zero or one scratch Auth account');
  IF EXISTS(SELECT 1 FROM auth.users) THEN
    PERFORM pg_temp.pickup_assert((SELECT count(*)=1 FROM public.profiles),'one bootstrap profile');
    SELECT u.id INTO retained_account FROM auth.users u JOIN public.profiles p ON p.id=u.id
      WHERE u.email_confirmed_at IS NOT NULL AND nullif(btrim(u.email),'') IS NOT NULL
        AND lower(p.email::text)=lower(u.email) AND p.roles=ARRAY['admin']::text[]
        AND jsonb_typeof(u.raw_app_meta_data)='object' AND u.raw_app_meta_data->'roles'='["admin"]'::jsonb;
    PERFORM pg_temp.pickup_assert(retained_account IS NOT NULL,'confirmed matching admin bootstrap only');
    -- audit_row() records lower(TG_OP): owner role-grant/bootstrap edits are
    -- profile/update with actor null or this account, not invented audit labels.
    PERFORM pg_temp.pickup_assert(NOT EXISTS(SELECT 1 FROM public.audit_log a
      WHERE a.table_name IS DISTINCT FROM 'profiles' OR a.action IS DISTINCT FROM 'update'
        OR a.row_id IS DISTINCT FROM retained_account::text
        OR (a.actor_id IS NOT NULL AND a.actor_id<>retained_account)), 'bootstrap audit history only');
  ELSE
    PERFORM pg_temp.pickup_assert(NOT EXISTS(SELECT 1 FROM public.profiles)
      AND NOT EXISTS(SELECT 1 FROM public.audit_log),'empty scratch profiles and audit');
  END IF;
  FOREACH relation_name IN ARRAY ARRAY['players','venues','clubs','teams','competitions','games',
    'role_grants','competition_registrations','game_registrations','fee_schedules','billing_periods',
    'charges','payments','period_player_summaries','period_account_summaries'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I',relation_name) INTO n;
    PERFORM pg_temp.pickup_assert(n=0,'empty scratch ' || relation_name);
  END LOOP;
  PERFORM pg_temp.pickup_assert(NOT EXISTS(SELECT 1 FROM auth.users u CROSS JOIN generate_series(101,106) n
    WHERE u.id=pg_temp.pickup_id(n) OR lower(u.email)='pickup-' || n || '@example.invalid')
    AND NOT EXISTS(SELECT 1 FROM public.profiles p CROSS JOIN generate_series(101,106) n
    WHERE p.id=pg_temp.pickup_id(n) OR lower(p.email::text)='pickup-' || n || '@example.invalid'),
    'synthetic account ID and email collision guard');
  INSERT INTO pg_temp.pickup_baseline
  SELECT retained_account,
    (SELECT md5(jsonb_build_object('id',u.id,'email',u.email,'confirmed_at',u.email_confirmed_at,
       'app_metadata',u.raw_app_meta_data,'updated_at',u.updated_at)::text) FROM auth.users u WHERE u.id=retained_account),
    (SELECT md5(to_jsonb(p)::text) FROM public.profiles p WHERE p.id=retained_account),
    coalesce(array_agg(a.id ORDER BY a.id),'{}'::bigint[]),
    md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb)::text) FROM public.audit_log a;
  PERFORM pg_temp.pickup_assert(to_regprocedure('public.save_pickup_game(uuid,timestamptz,jsonb)') IS NOT NULL,
    '0005 installed');
  PERFORM pg_temp.pickup_assert(NOT has_function_privilege('authenticated',
    'public.validate_pickup_game_details(jsonb)','EXECUTE'), 'parser stays private');
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated',
    (SELECT nspname FROM pg_catalog.pg_namespace WHERE oid=pg_my_temp_schema()));
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.pickup_id(integer),pg_temp.pickup_assert(boolean,text),
  pg_temp.pickup_error(text,text,text),pg_temp.pickup_claim(integer,jsonb),pg_temp.pickup_details(uuid)
  TO anon,authenticated;
CREATE TEMP TABLE pickup_state(label text PRIMARY KEY,id uuid,version timestamptz) ON COMMIT DROP;
GRANT SELECT,INSERT,UPDATE ON pg_temp.pickup_state TO authenticated;
GRANT SELECT(label,id) ON pg_temp.pickup_state TO anon;

INSERT INTO auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
SELECT pg_temp.pickup_id(n),'pickup-' || n || '@example.invalid','{}','{}',now(),now()
  FROM generate_series(101,106) n;
UPDATE public.profiles SET roles=ARRAY['admin'] WHERE id=pg_temp.pickup_id(101);

-- An admin can start on a fresh project without seeded teams or venues.
SET LOCAL ROLE authenticated;
SELECT pg_temp.pickup_claim(101,'["admin"]');
DO $$
DECLARE options jsonb; row_data record;
BEGIN
  options := public.pickup_game_options();
  PERFORM pg_temp.pickup_assert(options->'teams'='[]'::jsonb AND options->'venues'='[]'::jsonb
    AND options->'can_override_fee'='true'::jsonb,'empty admin options');
  SELECT * INTO STRICT row_data FROM public.save_pickup_game(NULL,NULL,pg_temp.pickup_details());
  PERFORM pg_temp.pickup_assert(row_data.team_id IS NULL AND row_data.venue_id IS NULL
    AND row_data.status='draft' AND row_data.fee_override IS NULL,'teamless venue-less draft');
  INSERT INTO pg_temp.pickup_state VALUES('admin',row_data.id,row_data.updated_at);
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
INSERT INTO public.clubs(id,name,is_us) VALUES
  (pg_temp.pickup_id(201),'Synthetic CalBlue',true),(pg_temp.pickup_id(202),'Synthetic visiting club',false);
INSERT INTO public.teams(id,club_id,name) VALUES
  (pg_temp.pickup_id(301),pg_temp.pickup_id(201),'Team A'),
  (pg_temp.pickup_id(302),pg_temp.pickup_id(201),'Team B'),
  (pg_temp.pickup_id(303),pg_temp.pickup_id(202),'Visitor');
INSERT INTO public.venues(id,name,timezone) VALUES(pg_temp.pickup_id(401),'Synthetic venue','Pacific/Honolulu');
INSERT INTO public.competitions(id,name,kind) VALUES(pg_temp.pickup_id(501),'Synthetic cup','cup');
INSERT INTO public.role_grants(account_id,role,team_id) VALUES
  (pg_temp.pickup_id(102),'organiser',pg_temp.pickup_id(301)),
  (pg_temp.pickup_id(103),'organiser',pg_temp.pickup_id(302)),
  (pg_temp.pickup_id(104),'captain',pg_temp.pickup_id(301));
INSERT INTO public.role_grants(account_id,role,competition_id)
  VALUES(pg_temp.pickup_id(106),'organiser',pg_temp.pickup_id(501));
INSERT INTO public.players(id,display_name) SELECT pg_temp.pickup_id(n),'Synthetic guest ' || n
  FROM generate_series(601,603) n;
INSERT INTO public.games(id,competition_id,game_type,title,start_time,status)
  VALUES(pg_temp.pickup_id(701),pg_temp.pickup_id(501),'cup','Unrelated fixture',now()+interval '35 days','draft');

SET LOCAL ROLE anon;
SELECT pg_temp.pickup_error('SELECT public.pickup_game_options()','42501');
SELECT pg_temp.pickup_error('SELECT * FROM public.list_pickup_games()','42501');
SELECT pg_temp.pickup_error('SELECT * FROM public.save_pickup_game(NULL,NULL,''{}'')','42501');
SELECT pg_temp.pickup_error('SELECT * FROM public.transition_pickup_game(NULL,NULL,''cancel'')','42501');
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
DECLARE actor integer; roles jsonb;
BEGIN
  FOREACH actor IN ARRAY ARRAY[104,105,106] LOOP
    PERFORM pg_temp.pickup_claim(actor);
    PERFORM pg_temp.pickup_error('SELECT public.pickup_game_options()','42501','pickup_forbidden');
    PERFORM pg_temp.pickup_error('SELECT * FROM public.list_pickup_games()','42501','pickup_forbidden');
    PERFORM pg_temp.pickup_error('SELECT * FROM public.save_pickup_game(NULL,NULL,''{}'')','42501','pickup_forbidden');
    PERFORM pg_temp.pickup_error('SELECT * FROM public.transition_pickup_game(NULL,NULL,''cancel'')','42501','pickup_forbidden');
  END LOOP;
  FOREACH roles IN ARRAY ARRAY['["developer"]'::jsonb,'["ADMIN"]'::jsonb,'["admin",7]'::jsonb] LOOP
    PERFORM pg_temp.pickup_claim(105,roles);
    PERFORM pg_temp.pickup_error('SELECT public.pickup_game_options()','42501','pickup_forbidden');
  END LOOP;
END $$;
-- Existing competition-fixture editing is not broadened or broken.
SELECT pg_temp.pickup_claim(106);
UPDATE public.games SET title='Unrelated fixture edited' WHERE id=pg_temp.pickup_id(701);
SELECT pg_temp.pickup_assert((SELECT title='Unrelated fixture edited' FROM public.games
  WHERE id=pg_temp.pickup_id(701)),'ordinary competition organiser edit');

SELECT pg_temp.pickup_claim(102);
DO $$
DECLARE options jsonb; row_data record; old_version timestamptz; payload jsonb;
BEGIN
  options := public.pickup_game_options();
  PERFORM pg_temp.pickup_assert(jsonb_array_length(options->'teams')=1
    AND options->'teams'->0->>'id'=pg_temp.pickup_id(301)::text
    AND options->'can_override_fee'='false'::jsonb,'organiser options limited to own CalBlue team');
  PERFORM pg_temp.pickup_assert(NOT public.can_manage_pickup_team(NULL)
    AND NOT public.can_manage_pickup_team(pg_temp.pickup_id(302)),'no teamless or other-team authority');
  payload := pg_temp.pickup_details(pg_temp.pickup_id(301)) || jsonb_build_object('venue_id',pg_temp.pickup_id(401));
  SELECT * INTO STRICT row_data FROM public.save_pickup_game(NULL,NULL,payload);
  PERFORM pg_temp.pickup_assert(row_data.timezone='Pacific/Honolulu'
    AND row_data.game_date=(row_data.start_time AT TIME ZONE 'Pacific/Honolulu')::date
    AND row_data.game_date=(row_data.start_time AT TIME ZONE 'UTC')::date-1,'venue authoritative timezone and local date');
  INSERT INTO pg_temp.pickup_state VALUES('organiser',row_data.id,row_data.updated_at);
  PERFORM pg_temp.pickup_assert(EXISTS(SELECT 1 FROM public.games WHERE id=row_data.id), 'own draft staff RLS visibility');
  PERFORM pg_temp.pickup_assert(NOT public.manages_game(row_data.id),'pickup scope does not grant contact/attendance authority');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.read_game_emergency_contacts(%L)',row_data.id),'42501');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(NULL,NULL,%L::jsonb)',
    payload || '{"fee_override":null}'::jsonb),'42501','pickup_fee_forbidden');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(NULL,NULL,%L::jsonb)',
    pg_temp.pickup_details()),'42501','pickup_forbidden');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(NULL,NULL,%L::jsonb)',
    pg_temp.pickup_details(pg_temp.pickup_id(302))),'42501','pickup_forbidden');
  old_version := row_data.updated_at;
  SELECT * INTO STRICT row_data FROM public.save_pickup_game(row_data.id,old_version,payload || '{"title":"Edited pickup"}');
  PERFORM pg_temp.pickup_assert(row_data.updated_at > old_version,'monotonic same-transaction CAS version');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(%L,%L,%L::jsonb)',
    row_data.id,old_version,payload),'P0001','pickup_conflict');
  UPDATE pg_temp.pickup_state SET version=row_data.updated_at WHERE label='organiser';
END $$;
SELECT pg_temp.pickup_claim(105);
SELECT pg_temp.pickup_assert(NOT EXISTS(SELECT g.id FROM public.games g JOIN pg_temp.pickup_state s ON s.id=g.id
  WHERE s.label IN ('admin','organiser')),'ordinary member cannot read either draft');
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
SET LOCAL ROLE anon;
SELECT pg_temp.pickup_assert(NOT EXISTS(SELECT g.id FROM public.games g JOIN pg_temp.pickup_state s ON s.id=g.id
  WHERE s.label IN ('admin','organiser')),'anonymous safe-column reads cannot see drafts');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.pickup_claim(103);
SELECT pg_temp.pickup_assert((SELECT count(*)=0 FROM public.list_pickup_games()),'other organiser cannot list drafts');
SELECT pg_temp.pickup_error(format('SELECT * FROM public.transition_pickup_game(%L,%L,''cancel'',''No'')',id,version),
  '42501','pickup_forbidden') FROM pg_temp.pickup_state WHERE label='organiser';

SELECT pg_temp.pickup_claim(101,'["admin"]');
DO $$
DECLARE row_data record; payload jsonb; bad jsonb; bad_time text;
BEGIN
  payload := pg_temp.pickup_details(pg_temp.pickup_id(301)) || '{"fee_override":12.50}';
  SELECT * INTO STRICT row_data FROM public.save_pickup_game(
    (SELECT id FROM pg_temp.pickup_state WHERE label='organiser'),
    (SELECT version FROM pg_temp.pickup_state WHERE label='organiser'),payload);
  UPDATE pg_temp.pickup_state SET version=row_data.updated_at WHERE label='organiser';
  PERFORM pg_temp.pickup_assert(row_data.fee_override=12.50,'admin fee override');
  FOREACH bad IN ARRAY ARRAY['{"status":"published"}'::jsonb,'{"competition_id":null}'::jsonb,
    '{"created_by":null}'::jsonb,'{"game_date":"2027-01-01"}'::jsonb,'{"no_show_fee_override":2}'::jsonb,
    '{"capacity":0}'::jsonb,'{"capacity":10001}'::jsonb,'{"capacity":"2"}'::jsonb,
    '{"fee_override":1.001}'::jsonb,'{"fee_override":100000000}'::jsonb,'{"timezone":"Not/A_Zone"}'::jsonb,
    '{"start_time":"infinity"}'::jsonb,'{"start_time":"2027-02-30T12:00:00Z"}'::jsonb,
    '{"start_time":"2027-01-01T24:00:00Z"}'::jsonb,
    jsonb_build_object('title',repeat('x',201)),jsonb_build_object('notes',repeat('x',4001))] LOOP
    PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(NULL,NULL,%L::jsonb)',payload || bad),
      '22023','pickup_invalid');
  END LOOP;
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(NULL,NULL,%L::jsonb)',payload-'title'),
    '22023','pickup_invalid');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(NULL,NULL,%L::jsonb)',
    payload || jsonb_build_object('team_id',pg_temp.pickup_id(303))),'22023','pickup_invalid');
  PERFORM pg_temp.pickup_error(format('UPDATE public.games SET title=''Direct bypass'' WHERE id=%L',row_data.id),
    '42501','pickup_rpc_required');
  PERFORM pg_temp.pickup_error(format('UPDATE public.games SET game_type=''training'' WHERE id=%L',row_data.id),
    '42501','pickup_rpc_required');
  PERFORM pg_temp.pickup_error('UPDATE public.games SET game_type=''pickup'',competition_id=NULL WHERE id=pg_temp.pickup_id(701)',
    '42501','pickup_rpc_required');
  PERFORM pg_temp.pickup_error('INSERT INTO public.games(game_type,title,start_time) VALUES(''pickup'',''Direct bypass'',now()+interval ''3 days'')',
    '42501','pickup_rpc_required');
  PERFORM pg_temp.pickup_assert((SELECT count(*)=20 FROM jsonb_object_keys(to_jsonb(row_data))), 'fixed safe 20-column projection');
END $$;

SELECT pg_temp.pickup_claim(102);
DO $$
DECLARE row_data record; payload jsonb;
BEGIN
  payload := pg_temp.pickup_details(pg_temp.pickup_id(301));
  SELECT * INTO STRICT row_data FROM public.save_pickup_game(
    (SELECT id FROM pg_temp.pickup_state WHERE label='organiser'),
    (SELECT version FROM pg_temp.pickup_state WHERE label='organiser'),payload || '{"notes":"  Operational note  "}');
  PERFORM pg_temp.pickup_assert(row_data.fee_override=12.50 AND row_data.notes='Operational note',
    'organiser edit preserves admin fee and normalizes notes');
  SELECT * INTO STRICT row_data FROM public.transition_pickup_game(row_data.id,row_data.updated_at,'publish');
  PERFORM pg_temp.pickup_assert(row_data.status='published','draft to published');
  UPDATE pg_temp.pickup_state SET version=row_data.updated_at WHERE label='organiser';
END $$;
SELECT pg_temp.pickup_claim(105);
SELECT pg_temp.pickup_assert(EXISTS(SELECT g.id FROM public.games g JOIN pg_temp.pickup_state s ON s.id=g.id
  WHERE s.label='organiser' AND g.status='published')
  AND NOT EXISTS(SELECT g.id FROM public.games g JOIN pg_temp.pickup_state s ON s.id=g.id WHERE s.label='admin'),
  'ordinary member sees published pickup but not admin draft');
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
SET LOCAL ROLE anon;
SELECT pg_temp.pickup_assert(EXISTS(SELECT g.id FROM public.games g JOIN pg_temp.pickup_state s ON s.id=g.id
  WHERE s.label='organiser' AND g.status='published')
  AND NOT EXISTS(SELECT g.id FROM public.games g JOIN pg_temp.pickup_state s ON s.id=g.id WHERE s.label='admin'),
  'anonymous safe-column reads see published pickup but not admin draft');
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
INSERT INTO public.game_registrations(game_id,player_id,status)
SELECT s.id,pg_temp.pickup_id(n),CASE WHEN n=603 THEN 'waitlisted' ELSE 'registered' END
  FROM pg_temp.pickup_state s CROSS JOIN generate_series(601,603) n
  WHERE s.label='organiser';
SELECT pg_temp.pickup_assert((SELECT count(*)=2 FROM public.game_registrations WHERE status='registered')
  AND (SELECT count(*)=1 FROM public.game_registrations WHERE status='waitlisted'),'capacity fixture 2 plus 1 waiter');

SET LOCAL ROLE authenticated;
SELECT pg_temp.pickup_claim(102);
DO $$
DECLARE row_data record; payload jsonb; old_version timestamptz;
BEGIN
  SELECT id,version AS updated_at INTO STRICT row_data FROM pg_temp.pickup_state WHERE label='organiser';
  payload := pg_temp.pickup_details(pg_temp.pickup_id(301));
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(%L,%L,%L::jsonb)',
    row_data.id,row_data.updated_at,payload || '{"capacity":1}'),'22023','pickup_capacity_conflict');
  SELECT * INTO STRICT row_data FROM public.save_pickup_game(row_data.id,row_data.updated_at,payload || '{"capacity":3}');
  SELECT * INTO STRICT row_data FROM public.transition_pickup_game(row_data.id,row_data.updated_at,'close');
  PERFORM pg_temp.pickup_assert(row_data.status='reg_closed','published to registration closed');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.transition_pickup_game(%L,%L,''publish'')',row_data.id,row_data.updated_at),
    'P0001','pickup_conflict');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.transition_pickup_game(%L,%L,''cancel'',%L)',
    row_data.id,row_data.updated_at,E' \n\t'),'22023','pickup_invalid');
  old_version := row_data.updated_at;
  SELECT * INTO STRICT row_data FROM public.transition_pickup_game(row_data.id,row_data.updated_at,'cancel','  Field unavailable  ');
  PERFORM pg_temp.pickup_assert(row_data.status='cancelled' AND row_data.cancellation_reason='Field unavailable','cancel with reason');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.transition_pickup_game(%L,%L,''cancel'',''Again'')',row_data.id,old_version),
    'P0001','pickup_conflict');
  PERFORM pg_temp.pickup_error(format('SELECT * FROM public.save_pickup_game(%L,%L,%L::jsonb)',row_data.id,row_data.updated_at,payload),
    'P0001','pickup_conflict');
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
SELECT pg_temp.pickup_assert((SELECT count(*)=3 FROM public.game_registrations)
  AND (SELECT count(*)=1 FROM public.game_registrations WHERE status='waitlisted')
  AND NOT EXISTS(SELECT 1 FROM public.charges),'cancel preserves registrations, no promotion or charges');

-- Owner-only setup for existing financial safeguards; no live account access.
INSERT INTO public.games(id,game_type,title,start_time,status,fee_override) VALUES
  (pg_temp.pickup_id(702),'pickup','Charged pickup',now()+interval '35 days','published',NULL),
  (pg_temp.pickup_id(703),'pickup','Completed pickup',now()-interval '1 day','completed',5),
  (pg_temp.pickup_id(704),'pickup','',now()+interval '35 days','draft',NULL),
  (pg_temp.pickup_id(705),'pickup','  Legacy noncanonical  ',now()+interval '35 days','draft',NULL);
INSERT INTO public.charges(player_id,game_id,kind,description,amount,charge_date,source)
  VALUES(pg_temp.pickup_id(601),pg_temp.pickup_id(702),'adjustment','Synthetic charge',1,current_date,'manual');
INSERT INTO public.game_registrations(game_id,player_id,attendance)
  VALUES(pg_temp.pickup_id(703),pg_temp.pickup_id(601),'present');
SET LOCAL ROLE authenticated;
SELECT pg_temp.pickup_claim(101,'["admin"]');
SELECT pg_temp.pickup_error(format('SELECT * FROM public.transition_pickup_game(%L,%L,''publish'')',id,updated_at),
  '22023','pickup_invalid') FROM public.games WHERE id IN (pg_temp.pickup_id(704),pg_temp.pickup_id(705));
SELECT pg_temp.pickup_error(format('SELECT * FROM public.transition_pickup_game(%L,%L,''cancel'',''No'')',id,updated_at),
  'P0001','pickup_conflict') FROM public.games WHERE id IN (pg_temp.pickup_id(702),pg_temp.pickup_id(703));
SELECT public.finalise_game_attendance(pg_temp.pickup_id(703));
SELECT pg_temp.pickup_assert((SELECT status='locked' AND attendance_locked_at IS NOT NULL FROM public.games
  WHERE id=pg_temp.pickup_id(703)),'existing trusted billing finalization still works');
SELECT pg_temp.pickup_error(format('SELECT * FROM public.transition_pickup_game(%L,%L,''cancel'',''No'')',id,updated_at),
  'P0001','pickup_conflict') FROM public.games WHERE id=pg_temp.pickup_id(703);
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',true);
SELECT pg_temp.pickup_assert((SELECT count(*)=1 AND min(amount)=5 FROM public.charges
  WHERE game_id=pg_temp.pickup_id(703)),'billing charge preserved');
DO $$
DECLARE baseline pg_temp.pickup_baseline;
BEGIN
  SELECT * INTO STRICT baseline FROM pg_temp.pickup_baseline;
  PERFORM pg_temp.pickup_assert((SELECT count(*) FROM auth.users)=6+CASE WHEN baseline.account_id IS NULL THEN 0 ELSE 1 END
    AND (SELECT count(*) FROM public.profiles)=6+CASE WHEN baseline.account_id IS NULL THEN 0 ELSE 1 END,
    'only six synthetic accounts added');
  IF baseline.account_id IS NOT NULL THEN
    PERFORM pg_temp.pickup_assert((SELECT md5(jsonb_build_object('id',u.id,'email',u.email,
      'confirmed_at',u.email_confirmed_at,'app_metadata',u.raw_app_meta_data,'updated_at',u.updated_at)::text)
      FROM auth.users u WHERE u.id=baseline.account_id) IS NOT DISTINCT FROM baseline.auth_fingerprint,
      'existing bootstrap Auth metadata unchanged');
    PERFORM pg_temp.pickup_assert((SELECT md5(to_jsonb(p)::text) FROM public.profiles p
      WHERE p.id=baseline.account_id) IS NOT DISTINCT FROM baseline.profile_fingerprint,
      'existing bootstrap profile and roles unchanged');
  END IF;
  PERFORM pg_temp.pickup_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb)::text)
    FROM public.audit_log a WHERE a.id=ANY(baseline.audit_ids))=baseline.audit_fingerprint,
    'preexisting audit history unchanged');
END $$;
DO $$ BEGIN RAISE NOTICE '0005 pickup games smoke passed; rolling back.'; END $$;
ROLLBACK;
