-- Human-run smoke test after 0001_core.sql AND 0002_money.sql on an EMPTY,
-- DISPOSABLE Supabase project. Run the complete file as postgres/database owner.
-- No production data, passwords or API keys. With psql, use -v ON_ERROR_STOP=1.
-- Synthetic rows, temporary helpers and changes roll back. Identity sequence
-- values may advance despite ROLLBACK (normal PostgreSQL behavior).
-- This script is source-reviewed, not executed by the coding agent. It does
-- not prove two-session concurrency, caller authorization or production safety.

BEGIN ISOLATION LEVEL READ COMMITTED;

CREATE FUNCTION pg_temp.money_id(number integer) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT ('c0260000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid;
$$;

CREATE FUNCTION pg_temp.money_assert(condition boolean, description text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'money smoke assertion failed: %', description;
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.money_expect_error(statement text, expected_state text,
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
      RAISE EXCEPTION 'money smoke expected % / %, received % / %',
        expected_state, expected_message, actual_state, actual_message;
    END IF;
    RETURN;
  END;
  -- Outside the handler: an unexpectedly successful statement cannot pass.
  RAISE EXCEPTION 'money smoke expected SQLSTATE %, but statement succeeded', expected_state;
END;
$$;

DO $$
DECLARE relation_name text; client_role text; privilege_name text; helper_name text;
        relation_id oid; helper_id oid; row_count bigint;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['profiles','players','games','game_registrations',
    'fee_schedules','billing_periods','charges','payments','period_player_summaries',
    'period_account_summaries','audit_log'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', relation_name) INTO row_count;
    PERFORM pg_temp.money_assert(row_count = 0, 'scratch-only guard: ' || relation_name || ' is empty');
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY['fee_schedules','billing_periods','charges','payments',
    'period_player_summaries','period_account_summaries','audit_log',
    'v_account_balance','v_account_ledger','v_public_roster'] LOOP
    relation_id := to_regclass('public.' || relation_name);
    PERFORM pg_temp.money_assert(relation_id IS NOT NULL, relation_name || ' exists');
    IF relation_name LIKE 'v_%' THEN
      PERFORM pg_temp.money_assert(
        (SELECT 'security_invoker=true' = ANY(reloptions) FROM pg_class WHERE oid = relation_id),
        relation_name || ' uses caller security');
    ELSE
      PERFORM pg_temp.money_assert(
        (SELECT relrowsecurity FROM pg_class WHERE oid = relation_id), relation_name || ' has RLS');
      PERFORM pg_temp.money_assert(
        NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = relation_id),
        relation_name || ' has no client policies before issue #27');
    END IF;
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        PERFORM pg_temp.money_assert(NOT has_table_privilege(client_role, relation_id, privilege_name),
          relation_name || ': no ' || privilege_name || ' for ' || client_role);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    PERFORM pg_temp.money_assert(
      NOT has_sequence_privilege(client_role, 'public.audit_log_id_seq', 'USAGE, SELECT, UPDATE'),
      'audit sequence is private to trusted execution');
  END LOOP;
  FOREACH helper_name IN ARRAY ARRAY['lock_billing()','lock_billing_statement()',
    'require_open_billing_date(date,uuid)','charges_are_immutable()','payments_are_immutable()',
    'guard_billing_period()','freeze_billing_history()','guard_billed_game()',
    'guard_billed_registration()','resolve_game_fee(uuid)','resolve_no_show_fee(uuid)',
    'write_game_attendance_charges(uuid)','finalise_game_attendance(uuid)',
    'assign_to_periods()','write_billing_period_summaries(uuid)','close_billing_period(uuid)','audit_row()'] LOOP
    helper_id := to_regprocedure('public.' || helper_name);
    PERFORM pg_temp.money_assert(helper_id IS NOT NULL, helper_name || ' exists');
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      PERFORM pg_temp.money_assert(NOT has_function_privilege(client_role, helper_id, 'EXECUTE'),
        helper_name || ' is not a client RPC');
    END LOOP;
    PERFORM pg_temp.money_assert(
      EXISTS (SELECT 1 FROM pg_proc, unnest(proconfig) AS config(setting)
              WHERE pg_proc.oid = helper_id AND setting IN ('search_path=', 'search_path=""')),
      helper_name || ' has a fixed empty search path');
  END LOOP;
END;
$$;

DO $$
DECLARE n integer; account_a uuid := pg_temp.money_id(101);
  account_b uuid := pg_temp.money_id(102); adult uuid := pg_temp.money_id(201);
  child uuid := pg_temp.money_id(202); other_player uuid := pg_temp.money_id(203);
  q1 uuid := pg_temp.money_id(701); q2 uuid := pg_temp.money_id(702);
  game1 uuid := pg_temp.money_id(501); game2 uuid := pg_temp.money_id(502);
  automatic_charge uuid;
BEGIN
  FOR n IN 101..102 LOOP
    INSERT INTO auth.users(id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
    VALUES (pg_temp.money_id(n), 'money-smoke-' || n || '@example.invalid',
      '{"display_name":"Synthetic billing member"}'::jsonb, '{"provider":"email"}'::jsonb, now(), now());
  END LOOP;
  INSERT INTO public.players(id, account_id, guardian_account_id, display_name) VALUES
    (adult, account_a, NULL, 'Synthetic parent'),
    (child, NULL, account_a, 'Synthetic child'),
    (other_player, account_b, NULL, 'Synthetic other member');
  FOR n IN 204..208 LOOP
    INSERT INTO public.players(id, display_name) VALUES (pg_temp.money_id(n), 'Synthetic guest ' || n);
  END LOOP;
  INSERT INTO public.competitions(id, name, kind, default_fee_per_game, default_no_show_fee) VALUES
    (pg_temp.money_id(301), 'Synthetic league', 'league', 12, 4),
    (pg_temp.money_id(302), 'Synthetic scheduled-fee league', 'league', NULL, NULL);
  INSERT INTO public.fee_schedules(id, name, competition_id, game_type, amount, effective_from) VALUES
    (pg_temp.money_id(401), 'Pickup fallback', NULL, 'pickup', 9, '2019-01-01'),
    (pg_temp.money_id(402), 'Competition fee', pg_temp.money_id(302), 'league', 7, '2019-01-01');
  INSERT INTO public.billing_periods(id, label, start_date, end_date) VALUES
    (q1, 'Smoke 2020 Q1', '2020-01-01', '2020-03-31'),
    (q2, 'Smoke 2020 Q2', '2020-04-01', '2020-06-30');
  PERFORM pg_temp.money_expect_error(
    'INSERT INTO public.billing_periods(label,start_date,end_date) VALUES (''Overlap'',''2020-03-31'',''2020-04-02'')',
    '23P01');

  INSERT INTO public.games(id, competition_id, game_type, title, start_time, status, fee_override, no_show_fee_override) VALUES
    (game1, pg_temp.money_id(301), 'league', 'Q1 played game', '2020-01-10 20:00:00+00', 'completed', 20, 5),
    (game2, pg_temp.money_id(301), 'league', 'Q2 played game', '2020-04-10 20:00:00+00', 'completed', 20, 5),
    (pg_temp.money_id(503), NULL, 'pickup', 'Draft game', '2020-01-20 20:00:00+00', 'draft', NULL, NULL),
    (pg_temp.money_id(504), NULL, 'pickup', 'To cancel', '2020-01-21 20:00:00+00', 'completed', 9, 3),
    (pg_temp.money_id(505), NULL, 'pickup', 'Unfinalised game', '2020-01-22 20:00:00+00', 'published', NULL, NULL),
    (pg_temp.money_id(511), pg_temp.money_id(301), 'league', 'Competition default', '2020-01-05 20:00:00+00', 'draft', NULL, NULL),
    (pg_temp.money_id(512), pg_temp.money_id(301), 'league', 'Zero override', '2020-01-05 20:00:00+00', 'completed', 0, 0),
    (pg_temp.money_id(513), pg_temp.money_id(302), 'league', 'Competition schedule', '2020-01-05 20:00:00+00', 'draft', NULL, NULL),
    (pg_temp.money_id(514), NULL, 'pickup', 'Game-type schedule', '2020-01-05 20:00:00+00', 'draft', NULL, NULL);
  PERFORM pg_temp.money_assert(public.resolve_game_fee(game1) = 20, 'per-game override wins');
  PERFORM pg_temp.money_assert(public.resolve_game_fee(pg_temp.money_id(511)) = 12, 'competition default');
  PERFORM pg_temp.money_assert(public.resolve_game_fee(pg_temp.money_id(512)) = 0, 'zero fee override is real');
  PERFORM pg_temp.money_assert(public.resolve_no_show_fee(pg_temp.money_id(512)) = 0, 'zero no-show override');
  PERFORM pg_temp.money_assert(public.resolve_game_fee(pg_temp.money_id(513)) = 7, 'competition fee schedule');
  PERFORM pg_temp.money_assert(public.resolve_game_fee(pg_temp.money_id(514)) = 9, 'game-type fee schedule');

  INSERT INTO public.game_registrations(id, game_id, player_id, status, participation, attendance, late_cancel) VALUES
    (pg_temp.money_id(601), game1, adult, 'registered', 'player', 'present', false),
    (pg_temp.money_id(602), game1, child, 'registered', 'keeper', 'present', false),
    (pg_temp.money_id(603), game1, other_player, 'registered', 'player', 'unknown', false),
    (pg_temp.money_id(604), game1, pg_temp.money_id(204), 'registered', 'coach', 'present', false),
    (pg_temp.money_id(605), game1, pg_temp.money_id(205), 'cancelled', 'player', 'present', true),
    (pg_temp.money_id(606), game1, pg_temp.money_id(206), 'registered', 'player', 'excused', false),
    (pg_temp.money_id(607), game2, child, 'registered', 'keeper', 'present', false),
    (pg_temp.money_id(608), pg_temp.money_id(504), other_player, 'registered', 'player', 'present', false),
    (pg_temp.money_id(609), game1, pg_temp.money_id(207), 'waitlisted', 'player', 'unknown', false),
    (pg_temp.money_id(610), game1, pg_temp.money_id(208), 'registered', 'volunteer', 'present', false),
    (pg_temp.money_id(611), pg_temp.money_id(512), pg_temp.money_id(206), 'registered', 'player', 'present', false);
  PERFORM public.finalise_game_attendance(pg_temp.money_id(512));
  PERFORM pg_temp.money_assert(NOT EXISTS (SELECT 1 FROM public.charges WHERE game_id=pg_temp.money_id(512)),
    'zero-fee attendance is recorded without a zero-valued charge');
  UPDATE public.games SET status = 'cancelled' WHERE id = pg_temp.money_id(504);
  PERFORM public.finalise_game_attendance(pg_temp.money_id(504));
  PERFORM pg_temp.money_assert(NOT EXISTS (SELECT 1 FROM public.charges WHERE game_id = pg_temp.money_id(504)),
    'cancelled games do not bill');
  PERFORM pg_temp.money_expect_error(format('SELECT public.finalise_game_attendance(%L)', pg_temp.money_id(599)),
    '23503', 'game_not_found');
  PERFORM pg_temp.money_expect_error(format('SELECT public.finalise_game_attendance(%L)', pg_temp.money_id(503)),
    '23514', 'game_must_be_completed');
  PERFORM public.finalise_game_attendance(game1);
  PERFORM public.finalise_game_attendance(game1);
  PERFORM pg_temp.money_assert(
    (SELECT count(*) = 3 AND sum(amount) = 45 FROM public.charges WHERE game_id = game1),
    'two finalizations create only two playing fees and one no-show charge');
  PERFORM pg_temp.money_assert(
    (SELECT attendance = 'absent' FROM public.game_registrations WHERE id = pg_temp.money_id(603)),
    'unknown registered attendance becomes absent');
  PERFORM pg_temp.money_assert(
    (SELECT account_id = account_a FROM public.charges WHERE game_id = game1 AND player_id = child),
    'guardian is snapshotted as payer');
  -- Direct trusted lifecycle transitions must use the same writer, not skip charges.
  UPDATE public.games SET status = 'locked' WHERE id = game2;
  PERFORM pg_temp.money_assert(
    (SELECT count(*) = 1 AND sum(amount) = 20 FROM public.charges WHERE game_id = game2),
    'direct completed-to-locked transition also writes charges');
  PERFORM pg_temp.money_expect_error(format(
    'UPDATE public.game_registrations SET attendance=''absent'' WHERE id=%L', pg_temp.money_id(601)),
    '23514', 'game_attendance_is_locked');
  PERFORM pg_temp.money_expect_error(format('UPDATE public.games SET fee_override=99 WHERE id=%L', game1),
    '23514', 'game_attendance_is_locked');

  SELECT id INTO automatic_charge FROM public.charges WHERE game_id = game1 AND player_id = adult;
  PERFORM pg_temp.money_expect_error(format('UPDATE public.charges SET amount=99 WHERE id=%L', automatic_charge),
    '23514', 'charges_are_immutable');
  PERFORM pg_temp.money_expect_error(format('UPDATE public.charges SET account_id=%L WHERE id=%L', account_b, automatic_charge),
    '23514', 'charges_are_immutable');
  PERFORM pg_temp.money_expect_error(format('UPDATE public.charges SET source=''manual'' WHERE id=%L', automatic_charge),
    '23514', 'charges_are_immutable');
  PERFORM pg_temp.money_expect_error(format('DELETE FROM public.charges WHERE id=%L', automatic_charge),
    '23514', 'charges_are_immutable');
  PERFORM pg_temp.money_expect_error(format('UPDATE public.charges SET voided_at=now() WHERE id=%L', automatic_charge),
    '23514', 'charge_void_reason_required');
  UPDATE public.charges SET voided_at=now(), void_reason='Synthetic correction' WHERE id=automatic_charge;
  PERFORM pg_temp.money_expect_error(format(
    'UPDATE public.charges SET voided_at=NULL,void_reason=NULL WHERE id=%L', automatic_charge),
    '23514', 'charge_void_is_final');
  PERFORM public.finalise_game_attendance(game1);
  PERFORM pg_temp.money_assert(
    (SELECT count(*) = 1 AND bool_and(voided_at IS NOT NULL) FROM public.charges
     WHERE game_id = game1 AND player_id = adult), 'retry does not regenerate a voided automatic charge');

  INSERT INTO public.charges(player_id, account_id, kind, description, amount, charge_date, source) VALUES
    (adult, account_a, 'adjustment', 'Opening charge', 12, '2019-12-31', 'manual'),
    (adult, account_a, 'credit', 'Current-quarter credit', -3, '2020-02-01', 'manual');
  -- Reserved future entry subject: FK validation arrives with hosted tournaments.
  INSERT INTO public.charges(entry_id, account_id, kind, description, amount, charge_date, source)
    VALUES (pg_temp.money_id(901), account_a, 'entry_fee', 'Synthetic future entry', 4, '2020-02-02', 'manual');
  PERFORM pg_temp.money_expect_error(format(
    'INSERT INTO public.charges(player_id,entry_id,kind,description,amount,charge_date,source) VALUES (%L,%L,''entry_fee'',''Invalid dual subject'',4,''2020-02-02'',''manual'')',
    adult, pg_temp.money_id(902)), '23514');
  INSERT INTO public.payments(id, account_id, amount, payment_date, method) VALUES
    (pg_temp.money_id(801), account_a, 2, '2019-12-31', 'cash'),
    (pg_temp.money_id(802), account_a, 10, '2020-02-03', 'venmo');
  PERFORM pg_temp.money_expect_error(format(
    'INSERT INTO public.payments(account_id,amount,payment_date,billing_period_id) VALUES (%L,1,''2020-02-03'',%L)', account_a, q2),
    '23514', 'billing_period_date_mismatch');
  PERFORM pg_temp.money_expect_error(format('UPDATE public.payments SET amount=90 WHERE id=%L', pg_temp.money_id(802)),
    '23514', 'payments_are_immutable');
  PERFORM pg_temp.money_expect_error(format('DELETE FROM public.payments WHERE id=%L', pg_temp.money_id(802)),
    '23514', 'payments_are_immutable');
  PERFORM public.assign_to_periods();
  PERFORM public.assign_to_periods();
  PERFORM pg_temp.money_assert(
    (SELECT billing_period_id = q1 FROM public.payments WHERE id=pg_temp.money_id(802)),
    'payments assigned once to their date-matching period');
  PERFORM pg_temp.money_expect_error(format('UPDATE public.payments SET billing_period_id=NULL WHERE id=%L', pg_temp.money_id(802)),
    '23514', 'billing_period_assignment_immutable');
  -- now() is transaction-stable; explicit old values demonstrate the touch trigger.
  UPDATE public.fee_schedules SET updated_at='2000-01-01 00:00:00+00';
  UPDATE public.payments SET updated_at='2000-01-01 00:00:00+00';
  PERFORM pg_temp.money_assert((SELECT bool_and(updated_at=now()) FROM public.fee_schedules), 'fee timestamps touch');
  PERFORM pg_temp.money_assert((SELECT bool_and(updated_at=now()) FROM public.payments), 'payment timestamps touch');

  PERFORM pg_temp.money_expect_error(format('SELECT public.close_billing_period(%L)', pg_temp.money_id(799)),
    '23503', 'billing_period_not_found');
  PERFORM pg_temp.money_expect_error(format('SELECT public.close_billing_period(%L)', q2),
    '23514', 'billing_period_close_out_of_order');
  PERFORM pg_temp.money_expect_error(format('SELECT public.close_billing_period(%L)', q1),
    '23514', 'billing_period_has_unfinalised_games');
  UPDATE public.games SET status='cancelled' WHERE id=pg_temp.money_id(505);
  PERFORM public.close_billing_period(q1);
  PERFORM pg_temp.money_assert(
    (SELECT status='closed' AND closed_at IS NOT NULL FROM public.billing_periods WHERE id=q1),
    'period closes only after validation');
  PERFORM pg_temp.money_assert(
    (SELECT games_attended=1 AND attended_league=1 AND charges_total=20
     FROM public.period_player_summaries WHERE billing_period_id=q1 AND player_id=child),
    'child Q1 attendance excludes Q2 and carries only Q1 charges');
  PERFORM pg_temp.money_assert(
    (SELECT games_attended=0 AND no_shows=1 AND charges_total=5
     FROM public.period_player_summaries WHERE billing_period_id=q1 AND player_id=other_player),
    'no-show summary excludes cancelled games');
  PERFORM pg_temp.money_assert(
    NOT EXISTS (SELECT 1 FROM public.period_player_summaries WHERE billing_period_id=q1 AND player_id=pg_temp.money_id(204)),
    'coaches do not acquire playing attendance counts');
  PERFORM pg_temp.money_assert(
    (SELECT games_attended=0 AND late_cancels=1 FROM public.period_player_summaries
     WHERE billing_period_id=q1 AND player_id=pg_temp.money_id(205)), 'late cancellations are tracked, not attended');
  PERFORM pg_temp.money_assert(
    (SELECT opening_balance=10 AND charges_total=21 AND payments_total=10 AND closing_balance=21
     FROM public.period_account_summaries WHERE billing_period_id=q1 AND account_id=account_a),
    'payer quarter includes carry, child, entry fee, credit, void and payment');
  -- A direct trusted close must generate the same snapshots as the public wrapper.
  UPDATE public.billing_periods SET status='closed' WHERE id=q2;
  PERFORM pg_temp.money_assert(
    (SELECT opening_balance=21 AND charges_total=20 AND payments_total=0 AND closing_balance=41
     FROM public.period_account_summaries WHERE billing_period_id=q2 AND account_id=account_a),
    'next quarter carries balance without recounting old charges');
  PERFORM pg_temp.money_assert(
    (SELECT games_attended=1 FROM public.period_player_summaries WHERE billing_period_id=q2 AND player_id=child),
    'second quarter does not count lifetime attendance');
  PERFORM pg_temp.money_assert(
    (SELECT balance=41 FROM public.v_account_balance WHERE account_id=account_a), 'live balance agrees with closed ledger');
  PERFORM pg_temp.money_assert(
    (SELECT sum(amount)=41 FROM public.v_account_ledger WHERE account_id=account_a), 'ledger signed lines agree with balance');

  PERFORM pg_temp.money_expect_error(format('UPDATE public.billing_periods SET status=''open'',closed_at=NULL WHERE id=%L', q1),
    '23514', 'billing_period_is_closed');
  PERFORM pg_temp.money_expect_error(format('DELETE FROM public.billing_periods WHERE id=%L', q1),
    '23514', 'billing_period_is_closed');
  PERFORM pg_temp.money_expect_error(format(
    'INSERT INTO public.payments(account_id,amount,payment_date) VALUES (%L,1,''2019-12-01'')', account_a),
    '23514', 'billing_history_closed');
  PERFORM pg_temp.money_expect_error(format(
    'UPDATE public.charges SET voided_at=now(),void_reason=''Too late'' WHERE game_id=%L AND player_id=%L', game1, child),
    '23514', 'billing_history_closed');
  PERFORM pg_temp.money_expect_error(format(
    'UPDATE public.payments SET updated_at=now() WHERE id=%L', pg_temp.money_id(802)),
    '23514', 'billing_history_closed');
  PERFORM pg_temp.money_expect_error('UPDATE public.period_player_summaries SET games_attended=99',
    '23514', 'billing_history_is_immutable');
  PERFORM pg_temp.money_expect_error('DELETE FROM public.period_account_summaries',
    '23514', 'billing_history_is_immutable');
  PERFORM pg_temp.money_expect_error('TRUNCATE public.period_player_summaries', '23514');
  PERFORM pg_temp.money_assert(
    EXISTS (SELECT 1 FROM public.audit_log WHERE table_name='charges' AND action='update' AND before IS NOT NULL AND after IS NOT NULL),
    'charge corrections retain before/after audit evidence');
  PERFORM pg_temp.money_assert(
    EXISTS (SELECT 1 FROM public.audit_log WHERE table_name='billing_periods' AND after->>'status'='closed'),
    'period close is audited');
  PERFORM pg_temp.money_expect_error('UPDATE public.audit_log SET action=''tampered''',
    '23514', 'billing_history_is_immutable');
  PERFORM pg_temp.money_expect_error('DELETE FROM public.audit_log', '23514', 'billing_history_is_immutable');
  PERFORM pg_temp.money_expect_error('TRUNCATE public.audit_log', '23514');
  -- Corrections remain possible as new facts after the sealed history cutoff.
  INSERT INTO public.payments(account_id, amount, payment_date, method, note)
    VALUES (account_a, -2, '2020-07-01', 'cash', 'Synthetic current-period refund');
  PERFORM pg_temp.money_assert(
    (SELECT balance=43 FROM public.v_account_balance WHERE account_id=account_a), 'refund is a new signed payment');
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM 1 FROM public.v_account_balance;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'money smoke: client could read private balances'; END IF;
  denied := false;
  BEGIN
    PERFORM public.finalise_game_attendance('c0260000-0000-4000-8000-000000000501'::uuid);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'money smoke: client could call privileged finalization'; END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE 'Money single-session smoke assertions passed; rolling back test rows. Two-session concurrency remains unverified.';
END;
$$;
ROLLBACK;
-- No success query after rollback: it could hide an earlier aborted transaction.
