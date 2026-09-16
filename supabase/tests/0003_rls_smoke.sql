-- Human-run authorization matrix after 0001, 0002 AND 0003 on an EMPTY,
-- DISPOSABLE Supabase project. Run the complete file as postgres/database owner.
-- Real database roles exercise RLS, triggers and RPC authorization. Synthetic
-- claims are set by the owner: this does not test JWT signing or browser Auth.
-- No passwords/private keys. All synthetic rows, helpers and temporary grants
-- roll back. Audit identity sequence values may advance despite rollback.
-- Not executed by the coding agent. Single-session tests do not prove race safety.

BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','',true);

CREATE FUNCTION pg_temp.rls_id(number integer) RETURNS uuid
LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$
  SELECT ('c0270000-0000-4000-8000-' || lpad(number::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.rls_assert(condition boolean, description text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS smoke assertion failed: %', description;
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.rls_expect_no_change(statement text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE changed bigint;
BEGIN
  BEGIN
    EXECUTE statement;
    GET DIAGNOSTICS changed=ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN RETURN;
  END;
  IF changed <> 0 THEN
    RAISE EXCEPTION 'RLS smoke: unauthorized write changed % rows', changed;
  END IF;
END;
$$;
CREATE FUNCTION pg_temp.rls_expect_error(statement text, expected_state text DEFAULT '42501') RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actual_state text; actual_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE, actual_message=MESSAGE_TEXT;
    IF actual_state <> expected_state THEN
      RAISE EXCEPTION 'RLS smoke expected %, received %: %', expected_state, actual_state, actual_message;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'RLS smoke expected SQLSTATE %, but statement succeeded', expected_state;
END;
$$;

DO $$
DECLARE relation_name text; client_role text; relation_id oid; n bigint; helper_name text;
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated',
    (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
  FOREACH relation_name IN ARRAY ARRAY['profiles','players','venues','clubs','teams',
    'competitions','games','role_grants','competition_registrations','game_registrations',
    'fee_schedules','billing_periods','charges','payments','period_player_summaries',
    'period_account_summaries','audit_log'] LOOP
    relation_id := to_regclass('public.' || relation_name);
    PERFORM pg_temp.rls_assert(relation_id IS NOT NULL, relation_name || ' exists');
    EXECUTE format('SELECT count(*) FROM public.%I',relation_name) INTO n;
    PERFORM pg_temp.rls_assert(n=0, 'scratch-only guard: ' || relation_name || ' is empty');
    PERFORM pg_temp.rls_assert((SELECT relrowsecurity FROM pg_class WHERE oid=relation_id),
      relation_name || ' has RLS');
    PERFORM pg_temp.rls_assert(EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=relation_id),
      relation_name || ' has policies');
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      PERFORM pg_temp.rls_assert(NOT has_table_privilege(client_role,relation_id,'TRUNCATE, REFERENCES, TRIGGER'),
        relation_name || ' has no dangerous client privileges');
    END LOOP;
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY['period_player_summaries','period_account_summaries','audit_log'] LOOP
    PERFORM pg_temp.rls_assert(NOT has_table_privilege('authenticated','public.' || relation_name,'INSERT, UPDATE, DELETE'),
      relation_name || ' is client read-only, including for an admin JWT');
  END LOOP;
  FOREACH helper_name IN ARRAY ARRAY['lock_billing()','assign_to_periods()',
    'write_game_attendance_charges(uuid)','write_billing_period_summaries(uuid)',
    'promote_from_waitlist(uuid)','finalise_game_attendance_internal(uuid)',
    'close_billing_period_internal(uuid)'] LOOP
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      PERFORM pg_temp.rls_assert(NOT has_function_privilege(client_role,'public.' || helper_name,'EXECUTE'),
        helper_name || ' remains private');
    END LOOP;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.rls_id(integer), pg_temp.rls_assert(boolean,text),
  pg_temp.rls_expect_error(text,text), pg_temp.rls_expect_no_change(text) TO anon, authenticated;

DO $$
DECLARE n integer;
BEGIN
  FOR n IN 101..108 LOOP
    INSERT INTO auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
    VALUES (pg_temp.rls_id(n),'rls-smoke-' || n || '@example.invalid',
      jsonb_build_object('display_name','Synthetic member ' || n),
      '{"provider":"email"}'::jsonb,now(),now());
  END LOOP;
  UPDATE public.profiles SET phone='PRIVATE SYNTHETIC PHONE',roles=ARRAY['player'];
  UPDATE public.profiles SET roles=ARRAY['admin'] WHERE id=pg_temp.rls_id(104);
  UPDATE public.profiles SET roles=ARRAY['developer'] WHERE id=pg_temp.rls_id(105);
  INSERT INTO public.players(id,account_id,guardian_account_id,display_name,verification_status,is_public,
    legal_name,date_of_birth,emergency_contact_name,emergency_contact_phone,medical_notes,claim_code) VALUES
    (pg_temp.rls_id(201),pg_temp.rls_id(101),NULL,'Synthetic member A','verified',false,
      'PRIVATE LEGAL A','1990-01-01','Emergency A','PRIVATE CONTACT A','PRIVATE MEDICAL A',NULL),
    (pg_temp.rls_id(202),pg_temp.rls_id(102),NULL,'Synthetic public member B','verified',true,
      'PRIVATE LEGAL B','1991-01-01','Emergency B','PRIVATE CONTACT B','PRIVATE MEDICAL B','PRIVATE CLAIM B'),
    (pg_temp.rls_id(203),NULL,pg_temp.rls_id(106),'Synthetic child','verified',false,
      'PRIVATE CHILD','2020-01-01','Guardian','PRIVATE GUARDIAN','PRIVATE CHILD MEDICAL',NULL),
    (pg_temp.rls_id(205),pg_temp.rls_id(106),NULL,'Synthetic parent','verified',false,
      NULL,'1990-01-01',NULL,NULL,NULL,NULL);
  INSERT INTO public.clubs(id,name,contact_phone) VALUES (pg_temp.rls_id(401),'Synthetic club','PRIVATE CLUB PHONE');
  INSERT INTO public.teams(id,club_id,name) VALUES (pg_temp.rls_id(411),pg_temp.rls_id(401),'Synthetic squad');
  INSERT INTO public.venues(id,name,address) VALUES (pg_temp.rls_id(421),'Synthetic field','Synthetic address');
  INSERT INTO public.competitions(id,name,kind,status) VALUES
    (pg_temp.rls_id(301),'Managed competition','league','published'),
    (pg_temp.rls_id(302),'Unrelated competition','league','published'),
    (pg_temp.rls_id(303),'Private draft competition','league','draft');
  INSERT INTO public.games(id,competition_id,game_type,title,start_time,status,capacity,fee_override,no_show_fee_override) VALUES
    (pg_temp.rls_id(501),pg_temp.rls_id(301),'league','Managed match','2030-01-10 20:00:00+00','published',NULL,10,3),
    (pg_temp.rls_id(502),pg_temp.rls_id(302),'league','Unrelated match','2030-01-11 20:00:00+00','published',NULL,10,3),
    (pg_temp.rls_id(503),pg_temp.rls_id(301),'league','To finalize','2030-01-12 20:00:00+00','completed',NULL,10,3),
    (pg_temp.rls_id(504),NULL,'pickup','Waitlist match','2030-01-13 20:00:00+00','published',1,10,3),
    (pg_temp.rls_id(505),pg_temp.rls_id(301),'league','Managed draft','2030-01-14 20:00:00+00','draft',NULL,10,3),
    (pg_temp.rls_id(506),pg_temp.rls_id(302),'league','Unrelated draft','2030-01-15 20:00:00+00','draft',NULL,10,3),
    (pg_temp.rls_id(507),NULL,'pickup','Open pickup','2030-01-16 20:00:00+00','published',NULL,10,3);
  INSERT INTO public.role_grants(id,account_id,role,competition_id,game_id) VALUES
    (pg_temp.rls_id(451),pg_temp.rls_id(103),'organiser',pg_temp.rls_id(301),NULL),
    (pg_temp.rls_id(452),pg_temp.rls_id(107),'captain',NULL,pg_temp.rls_id(504)),
    (pg_temp.rls_id(453),pg_temp.rls_id(107),'captain',NULL,pg_temp.rls_id(503));
  INSERT INTO public.competition_registrations(id,competition_id,player_id,status) VALUES
    (pg_temp.rls_id(621),pg_temp.rls_id(301),pg_temp.rls_id(201),'approved'),
    (pg_temp.rls_id(622),pg_temp.rls_id(301),pg_temp.rls_id(202),'pending'),
    (pg_temp.rls_id(623),pg_temp.rls_id(301),pg_temp.rls_id(203),'approved');
  INSERT INTO public.game_registrations(id,game_id,player_id,status,attendance) VALUES
    (pg_temp.rls_id(601),pg_temp.rls_id(501),pg_temp.rls_id(201),'registered','unknown'),
    (pg_temp.rls_id(602),pg_temp.rls_id(501),pg_temp.rls_id(202),'registered','unknown'),
    (pg_temp.rls_id(603),pg_temp.rls_id(501),pg_temp.rls_id(203),'registered','unknown'),
    (pg_temp.rls_id(604),pg_temp.rls_id(503),pg_temp.rls_id(201),'registered','present'),
    (pg_temp.rls_id(605),pg_temp.rls_id(503),pg_temp.rls_id(202),'registered','unknown'),
    (pg_temp.rls_id(606),pg_temp.rls_id(504),pg_temp.rls_id(201),'registered','unknown'),
    (pg_temp.rls_id(607),pg_temp.rls_id(504),pg_temp.rls_id(202),'waitlisted','unknown');
  INSERT INTO public.fee_schedules(name,game_type,amount,effective_from)
    VALUES ('Public pickup price','pickup',10,'2020-01-01');
  INSERT INTO public.billing_periods(id,label,start_date,end_date) VALUES
    (pg_temp.rls_id(701),'Empty historical quarter','2020-01-01','2020-03-31'),
    (pg_temp.rls_id(702),'Visibility-test quarter','2030-01-01','2030-03-31');
  INSERT INTO public.charges(id,player_id,account_id,kind,description,amount,charge_date,source) VALUES
    (pg_temp.rls_id(801),pg_temp.rls_id(201),pg_temp.rls_id(101),'adjustment','Synthetic A',12,'2030-01-01','manual'),
    (pg_temp.rls_id(802),pg_temp.rls_id(202),pg_temp.rls_id(102),'adjustment','Synthetic B',25,'2030-01-01','manual'),
    (pg_temp.rls_id(803),pg_temp.rls_id(203),pg_temp.rls_id(106),'adjustment','Synthetic child',40,'2030-01-01','manual');
  INSERT INTO public.payments(account_id,amount,payment_date) VALUES
    (pg_temp.rls_id(101),2,'2030-01-02'),(pg_temp.rls_id(102),5,'2030-01-02'),(pg_temp.rls_id(106),4,'2030-01-02');
  -- Owner-created snapshots test visibility only, not the quarterly writer (tested in 0002).
  INSERT INTO public.period_player_summaries(billing_period_id,player_id,account_id,charges_total) VALUES
    (pg_temp.rls_id(702),pg_temp.rls_id(201),pg_temp.rls_id(101),12),
    (pg_temp.rls_id(702),pg_temp.rls_id(202),pg_temp.rls_id(102),25),
    (pg_temp.rls_id(702),pg_temp.rls_id(203),pg_temp.rls_id(106),40);
  INSERT INTO public.period_account_summaries(billing_period_id,account_id,opening_balance,charges_total,payments_total,closing_balance) VALUES
    (pg_temp.rls_id(702),pg_temp.rls_id(101),0,12,2,10),
    (pg_temp.rls_id(702),pg_temp.rls_id(102),0,25,5,20),
    (pg_temp.rls_id(702),pg_temp.rls_id(106),0,40,4,36);
END;
$$;

-- Anonymous: published data and the five-field opt-in roster, never private base rows.
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SET LOCAL ROLE anon;
SELECT pg_temp.rls_assert((SELECT count(*)=5 FROM public.games),'anonymous published games only');
SELECT pg_temp.rls_assert((SELECT count(*)=2 FROM public.competitions),'anonymous published competitions only');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.v_public_roster),'opt-in verified public roster');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.venues),'public venues');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.teams),'public teams');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.fee_schedules),'public fee schedules');
SELECT pg_temp.rls_expect_error('SELECT phone FROM public.profiles');
SELECT pg_temp.rls_expect_error('SELECT medical_notes FROM public.players');
SELECT pg_temp.rls_expect_error('SELECT legal_name FROM public.v_public_roster','42703');
SELECT pg_temp.rls_expect_error('SELECT contact_phone FROM public.clubs');
SELECT pg_temp.rls_expect_error('SELECT notes FROM public.venues');
SELECT pg_temp.rls_expect_error('SELECT notes FROM public.games');
SELECT pg_temp.rls_expect_error('SELECT created_by FROM public.games');
SELECT pg_temp.rls_expect_error('SELECT * FROM public.charges');
SELECT pg_temp.rls_expect_error('SELECT public.finalise_game_attendance(pg_temp.rls_id(503))');
RESET ROLE;

-- Member A: own private rows and finances, no cross-member access or staff powers.
SELECT set_config('request.jwt.claims','{"sub":"c0270000-0000-4000-8000-000000000101","role":"authenticated","app_metadata":{"roles":["player"]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.profiles),'member sees only own profile');
SELECT pg_temp.rls_assert((SELECT count(*)=0 FROM public.profiles WHERE phone IS NOT NULL AND id=pg_temp.rls_id(102)),
  'another member phone is invisible');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.players),'public opt-in does not expose raw private player columns');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.v_public_roster),'member also sees safe public roster');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.charges),'only own charges');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.payments),'only own payments');
SELECT pg_temp.rls_assert((SELECT count(*)=1 AND min(balance)=10 FROM public.v_account_balance),'own balance only');
SELECT pg_temp.rls_assert((SELECT count(*)=2 AND sum(amount)=10 FROM public.v_account_ledger),'own signed ledger only');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.period_player_summaries),'own player summary only');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.period_account_summaries),'own payer summary only');
SELECT pg_temp.rls_assert((SELECT count(*)=0 FROM public.audit_log),'audit hidden from members');
UPDATE public.profiles SET phone='UPDATED OWN PHONE' WHERE id=pg_temp.rls_id(101);
SELECT pg_temp.rls_assert((SELECT phone='UPDATED OWN PHONE' FROM public.profiles WHERE id=pg_temp.rls_id(101)),'own phone edit');
UPDATE public.game_registrations SET jersey_number=19 WHERE id=pg_temp.rls_id(601);
SELECT pg_temp.rls_assert((SELECT jersey_number=19 FROM public.game_registrations WHERE id=pg_temp.rls_id(601)),'own match number edit');
SELECT pg_temp.rls_expect_error('UPDATE public.players SET verification_status=''rejected'' WHERE id=pg_temp.rls_id(201)');
SELECT pg_temp.rls_expect_error('UPDATE public.players SET guardian_account_id=pg_temp.rls_id(102) WHERE id=pg_temp.rls_id(201)');
SELECT pg_temp.rls_expect_error('UPDATE public.game_registrations SET attendance=''present'' WHERE id=pg_temp.rls_id(601)');
SELECT pg_temp.rls_expect_error('INSERT INTO public.game_registrations(game_id,player_id,attendance) VALUES (pg_temp.rls_id(507),pg_temp.rls_id(201),''present'')');
SELECT pg_temp.rls_expect_error('INSERT INTO public.game_registrations(game_id,player_id,checked_in_by) VALUES (pg_temp.rls_id(507),pg_temp.rls_id(201),pg_temp.rls_id(101))');
SELECT pg_temp.rls_expect_error('INSERT INTO public.game_registrations(game_id,player_id,late_cancel) VALUES (pg_temp.rls_id(507),pg_temp.rls_id(201),true)');
INSERT INTO public.game_registrations(game_id,player_id) VALUES (pg_temp.rls_id(507),pg_temp.rls_id(201));
SELECT pg_temp.rls_expect_error('INSERT INTO public.competition_registrations(competition_id,player_id,status) VALUES (pg_temp.rls_id(302),pg_temp.rls_id(201),''approved'')');
INSERT INTO public.competition_registrations(competition_id,player_id) VALUES (pg_temp.rls_id(302),pg_temp.rls_id(201));
SELECT pg_temp.rls_expect_error('UPDATE public.competition_registrations SET status=''approved'' WHERE competition_id=pg_temp.rls_id(302) AND player_id=pg_temp.rls_id(201)');
SELECT pg_temp.rls_expect_error('INSERT INTO public.payments(account_id,amount,payment_date) VALUES (pg_temp.rls_id(101),99,''2030-01-01'')');
SELECT pg_temp.rls_expect_error('SELECT public.finalise_game_attendance(pg_temp.rls_id(503))');
SELECT pg_temp.rls_expect_error('SELECT public.close_billing_period(pg_temp.rls_id(701))');
SELECT pg_temp.rls_expect_error('SELECT public.assign_to_periods()');
SELECT pg_temp.rls_expect_error('SELECT * FROM public.read_game_emergency_contacts(pg_temp.rls_id(501))');
UPDATE public.game_registrations SET status='cancelled' WHERE id=pg_temp.rls_id(606);
RESET ROLE;
SELECT pg_temp.rls_assert((SELECT status='registered' FROM public.game_registrations WHERE id=pg_temp.rls_id(607)),
  'ordinary member cancellation still promotes another member through private internal code');

-- New member: insert-time verification and ownership guards cannot be bypassed.
SELECT set_config('request.jwt.claims','{"sub":"c0270000-0000-4000-8000-000000000108","role":"authenticated","app_metadata":{"roles":["player"]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.rls_expect_error('INSERT INTO public.players(account_id,display_name,verification_status) VALUES (pg_temp.rls_id(108),''Invalid verified member'',''verified'')');
SELECT pg_temp.rls_expect_error('INSERT INTO public.players(account_id,display_name) VALUES (pg_temp.rls_id(102),''Invalid other owner'')');
WITH inserted AS (
  INSERT INTO public.players(id,account_id,display_name)
  VALUES (pg_temp.rls_id(208),pg_temp.rls_id(108),'Synthetic new pending member') RETURNING id
) SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM inserted),'own identity INSERT RETURNING is authorized');
SELECT pg_temp.rls_assert((SELECT verification_status='pending' FROM public.players WHERE id=pg_temp.rls_id(208)),'own pending identity creation');
SELECT pg_temp.rls_expect_error('UPDATE public.players SET account_id=pg_temp.rls_id(107) WHERE id=pg_temp.rls_id(208)');
RESET ROLE;

-- Captain: only granted matches, including the checked finalization RPC.
SELECT set_config('request.jwt.claims','{"sub":"c0270000-0000-4000-8000-000000000107","role":"authenticated","app_metadata":{"roles":[]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.rls_assert(public.manages_game(pg_temp.rls_id(504)) AND NOT public.manages_game(pg_temp.rls_id(501)), 'captain match scope');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.read_game_emergency_contacts(pg_temp.rls_id(504))), 'cancelled registrants excluded from emergency roster');
UPDATE public.game_registrations SET attendance='present' WHERE id=pg_temp.rls_id(607);
SELECT pg_temp.rls_assert((SELECT attendance='present' FROM public.game_registrations WHERE id=pg_temp.rls_id(607)), 'captain check-in');
SELECT pg_temp.rls_expect_error('SELECT * FROM public.read_game_emergency_contacts(pg_temp.rls_id(501))');
SELECT public.finalise_game_attendance(pg_temp.rls_id(503));
SELECT pg_temp.rls_assert((SELECT status='locked' FROM public.games WHERE id=pg_temp.rls_id(503)), 'captain can finalize granted completed match');
SELECT pg_temp.rls_expect_error('SELECT public.close_billing_period(pg_temp.rls_id(701))');
RESET ROLE;

-- Scoped organiser: manage competition A, never competition B or private finances.
SELECT set_config('request.jwt.claims','{"sub":"c0270000-0000-4000-8000-000000000103","role":"authenticated","app_metadata":{"roles":[]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.rls_assert(public.manages_game(pg_temp.rls_id(501)) AND NOT public.manages_game(pg_temp.rls_id(502)), 'scoped management');
SELECT pg_temp.rls_assert((SELECT count(*)=0 FROM public.players),'organiser has no broad private player read');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.profiles),'organiser cannot read member phone directory');
SELECT pg_temp.rls_assert((SELECT count(*)=0 FROM public.charges),'organiser cannot read other members charges');
SELECT pg_temp.rls_assert((SELECT count(*)=3 FROM public.read_game_emergency_contacts(pg_temp.rls_id(501))), 'only registered managed-game emergency contacts');
SELECT pg_temp.rls_expect_error('SELECT * FROM public.read_game_emergency_contacts(pg_temp.rls_id(502))');
UPDATE public.games SET title='Organiser edited match' WHERE id=pg_temp.rls_id(501);
SELECT pg_temp.rls_assert((SELECT title='Organiser edited match' FROM public.games WHERE id=pg_temp.rls_id(501)), 'managed fixture edit');
WITH changed AS (UPDATE public.games SET title='Unauthorized' WHERE id=pg_temp.rls_id(502) RETURNING id)
  SELECT pg_temp.rls_assert((SELECT count(*)=0 FROM changed),'unrelated fixture update is filtered');
SELECT pg_temp.rls_expect_error('UPDATE public.games SET competition_id=pg_temp.rls_id(302) WHERE id=pg_temp.rls_id(501)');
WITH inserted AS (
  INSERT INTO public.games(id,competition_id,game_type,title,start_time)
  VALUES (pg_temp.rls_id(508),pg_temp.rls_id(301),'league','New managed draft','2030-01-20 20:00:00+00') RETURNING id
) SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM inserted),'organiser draft INSERT RETURNING is authorized');
SELECT pg_temp.rls_expect_error('INSERT INTO public.games(competition_id,game_type,title,start_time) VALUES (pg_temp.rls_id(302),''league'',''Unauthorized draft'',''2030-01-20 20:00:00+00'')');
SELECT pg_temp.rls_expect_error('INSERT INTO public.role_grants(account_id,role,competition_id) VALUES (pg_temp.rls_id(103),''organiser'',pg_temp.rls_id(302))');
SELECT pg_temp.rls_expect_no_change('UPDATE public.role_grants SET role=''captain'' WHERE id=pg_temp.rls_id(451)');
INSERT INTO public.role_grants(id,account_id,role,competition_id)
VALUES (pg_temp.rls_id(454),pg_temp.rls_id(108),'coach',pg_temp.rls_id(301));
SELECT pg_temp.rls_assert(EXISTS (SELECT 1 FROM public.role_grants WHERE id=pg_temp.rls_id(454)), 'organiser subordinate grant');
DELETE FROM public.role_grants WHERE id=pg_temp.rls_id(454);
UPDATE public.competition_registrations SET status='approved' WHERE id=pg_temp.rls_id(622);
SELECT pg_temp.rls_assert((SELECT status='approved' FROM public.competition_registrations WHERE id=pg_temp.rls_id(622)), 'managed roster approval');
UPDATE public.game_registrations SET attendance='present' WHERE id=pg_temp.rls_id(602);
SELECT pg_temp.rls_assert((SELECT attendance='present' FROM public.game_registrations WHERE id=pg_temp.rls_id(602)), 'managed check-in');
SELECT pg_temp.rls_expect_error('UPDATE public.game_registrations SET status=''cancelled'' WHERE id=pg_temp.rls_id(603)');
SELECT pg_temp.rls_expect_error('SELECT public.finalise_game_attendance(pg_temp.rls_id(502))');
SELECT public.finalise_game_attendance(pg_temp.rls_id(503));
SELECT pg_temp.rls_expect_error('SELECT public.close_billing_period(pg_temp.rls_id(701))');
RESET ROLE;

-- Guardian: manage the child and see the family's payer-owned records.
SELECT set_config('request.jwt.claims','{"sub":"c0270000-0000-4000-8000-000000000106","role":"authenticated","app_metadata":{"roles":["player"]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.rls_assert((SELECT count(*)=2 FROM public.players),'guardian sees own identity and child');
SELECT pg_temp.rls_assert((SELECT medical_notes='PRIVATE CHILD MEDICAL' FROM public.players WHERE id=pg_temp.rls_id(203)),'guardian private child fields');
SELECT pg_temp.rls_assert((SELECT count(*)=1 AND min(balance)=36 FROM public.v_account_balance),'guardian sees child payer balance');
UPDATE public.game_registrations SET status='cancelled' WHERE id=pg_temp.rls_id(603);
SELECT pg_temp.rls_assert((SELECT status='cancelled' FROM public.game_registrations WHERE id=pg_temp.rls_id(603)), 'guardian may cancel child');
RESET ROLE;

-- Developer is not a business administrator.
SELECT set_config('request.jwt.claims','{"sub":"c0270000-0000-4000-8000-000000000105","role":"authenticated","app_metadata":{"roles":["developer"]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.rls_assert(NOT public.is_admin(),'developer is not admin');
SELECT pg_temp.rls_assert((SELECT count(*)=1 FROM public.profiles),'developer sees only own profile');
SELECT pg_temp.rls_assert((SELECT count(*)=0 FROM public.charges),'developer has no blanket financial read');
SELECT pg_temp.rls_assert((SELECT count(*)=0 FROM public.audit_log),'audit containing private data is not a developer directory');
SELECT pg_temp.rls_expect_error('UPDATE public.profiles SET roles=ARRAY[''admin''] WHERE id=pg_temp.rls_id(105)');
SELECT pg_temp.rls_expect_error('INSERT INTO public.fee_schedules(name,game_type,amount) VALUES (''Unauthorized'',''pickup'',0)');
SELECT pg_temp.rls_expect_error('SELECT public.close_billing_period(pg_temp.rls_id(701))');
RESET ROLE;

-- Admin: business writes and authorized RPCs; immutable history/internal RPCs remain protected.
SELECT set_config('request.jwt.claims','{"sub":"c0270000-0000-4000-8000-000000000104","role":"authenticated","app_metadata":{"roles":["admin"]}}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.rls_assert((SELECT count(*)=8 FROM public.profiles),'admin reads all synthetic profiles');
SELECT pg_temp.rls_assert((SELECT count(*)=5 FROM public.charges),'admin reads financial rows including finalized match');
UPDATE public.players SET verification_status='verified' WHERE id=pg_temp.rls_id(208);
SELECT pg_temp.rls_assert((SELECT verification_status='verified' FROM public.players WHERE id=pg_temp.rls_id(208)),'admin verification');
SELECT public.finalise_game_attendance(pg_temp.rls_id(503));
SELECT public.finalise_game_attendance(pg_temp.rls_id(503));
SELECT pg_temp.rls_assert((SELECT status='locked' FROM public.games WHERE id=pg_temp.rls_id(503)),'authorized finalization');
SELECT pg_temp.rls_assert((SELECT attendance='absent' FROM public.game_registrations WHERE id=pg_temp.rls_id(605)),'private writer still converts unknown attendance');
SELECT pg_temp.rls_assert((SELECT count(*)=2 AND sum(amount)=13 FROM public.charges WHERE game_id=pg_temp.rls_id(503)),'authorized finalization is retry-safe');
INSERT INTO public.charges(id,player_id,account_id,kind,description,amount,charge_date,source)
VALUES (pg_temp.rls_id(804),pg_temp.rls_id(201),pg_temp.rls_id(101),'credit','Synthetic admin credit',-1,'2030-01-03','manual');
SELECT pg_temp.rls_assert(EXISTS (SELECT 1 FROM public.charges WHERE id=pg_temp.rls_id(804)), 'admin can issue a player credit');
INSERT INTO public.payments(id,account_id,amount,payment_date)
VALUES (pg_temp.rls_id(814),pg_temp.rls_id(101),-1,'2030-01-03');
SELECT pg_temp.rls_assert(EXISTS (SELECT 1 FROM public.payments WHERE id=pg_temp.rls_id(814)), 'admin can record a refund');
UPDATE public.charges SET voided_at=now(),void_reason='Synthetic admin correction' WHERE id=pg_temp.rls_id(801);
SELECT pg_temp.rls_assert((SELECT voided_at IS NOT NULL FROM public.charges WHERE id=pg_temp.rls_id(801)), 'admin can void with a reason');
UPDATE public.fee_schedules SET amount=11;
SELECT pg_temp.rls_assert((SELECT min(amount)=11 FROM public.fee_schedules), 'admin manages fees');
SELECT public.close_billing_period(pg_temp.rls_id(701));
SELECT pg_temp.rls_assert((SELECT status='closed' FROM public.billing_periods WHERE id=pg_temp.rls_id(701)),'authorized empty quarter close');
SELECT pg_temp.rls_assert(EXISTS (SELECT 1 FROM public.audit_log),'admin reads audit evidence');
SELECT pg_temp.rls_assert(EXISTS (SELECT 1 FROM public.audit_log WHERE table_name='role_grants' AND action='delete'),
  'scoped grant revocation is audited');
SELECT pg_temp.rls_expect_error('SELECT public.write_game_attendance_charges(pg_temp.rls_id(503))');
SELECT pg_temp.rls_expect_error('SELECT public.finalise_game_attendance_internal(pg_temp.rls_id(503))');
SELECT pg_temp.rls_expect_error('INSERT INTO public.charges(entry_id,account_id,kind,description,amount,charge_date,source) VALUES (pg_temp.rls_id(999),pg_temp.rls_id(104),''entry_fee'',''Unvalidated future entry'',5,''2030-01-01'',''manual'')');
SELECT pg_temp.rls_expect_error('INSERT INTO public.period_account_summaries(billing_period_id,account_id) VALUES (pg_temp.rls_id(702),pg_temp.rls_id(104))');
SELECT pg_temp.rls_expect_error('DELETE FROM public.audit_log');
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE 'Single-session RLS matrix assertions passed; rolling back. Browser Auth and two-session concurrency remain untested.';
END;
$$;
ROLLBACK;
-- No success query after ROLLBACK: it could conceal an earlier aborted transaction.
