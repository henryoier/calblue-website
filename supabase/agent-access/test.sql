-- SUPERSEDED DEFAULT: Henry and his agent now require club admin access.
-- See README.md and grant-admin.sql. This is the optional historical read-only proposal.
-- Local PostgreSQL SUPERUSER-run against a DISPOSABLE database with migrations 0001-0004 and
-- provision.sql installed. Synthetic changes and test grants roll back.
-- SET SESSION AUTHORIZATION tests actual role escalation boundaries. The hosted
-- Supabase postgres role is not a superuser; do not run this test in production.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles) THEN
    RAISE EXCEPTION 'Tests require an empty disposable database';
  END IF;
END $$;

CREATE FUNCTION pg_temp.expect_denied(statement text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN insufficient_privilege THEN RETURN;
  END;
  RAISE EXCEPTION 'Expected permission denied: %', statement;
END $$;
CREATE FUNCTION pg_temp.assert_ok(value boolean) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed'; END IF;
END $$;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO calblue_henry_agent, anon, authenticated',
                 (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()));
END $$;

INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
VALUES ('a1111111-1111-4111-8111-111111111111', 'fictional@example.com',
        '{"display_name":"Fictional player"}', '{}');
INSERT INTO public.players (id, account_id, display_name, date_of_birth, medical_notes, claim_code)
VALUES ('a4444444-4444-4444-8444-444444444444', 'a1111111-1111-4111-8111-111111111111', 'Fictional player',
        '1990-01-01', 'PRIVATE MEDICAL TEXT', 'PRIVATE CLAIM CODE');
INSERT INTO public.charges (id, player_id, account_id, kind, description, amount, charge_date, source)
VALUES ('a2222222-2222-4222-8222-222222222222',
        'a4444444-4444-4444-8444-444444444444',
        'a1111111-1111-4111-8111-111111111111', 'season_dues', 'PRIVATE NOTE', 100,
        current_date, 'manual'),
       ('a3333333-3333-4333-8333-333333333333',
        'a4444444-4444-4444-8444-444444444444',
        'a1111111-1111-4111-8111-111111111111', 'season_dues', 'VOID', 50,
        current_date, 'manual');
UPDATE public.charges SET voided_at = now(), void_reason = 'synthetic correction'
 WHERE id = 'a3333333-3333-4333-8333-333333333333';
INSERT INTO public.payments (account_id, amount, method, payment_date, note)
VALUES ('a1111111-1111-4111-8111-111111111111', 40, 'zelle', current_date, 'PRIVATE PAYMENT'),
       ('a1111111-1111-4111-8111-111111111111', -10, 'zelle', current_date, 'PRIVATE REFUND');

SET LOCAL SESSION AUTHORIZATION calblue_henry_agent;
-- Changing the convenience setting must not bypass ACL enforcement.
SET LOCAL default_transaction_read_only = off;
SELECT pg_temp.assert_ok((SELECT count(*) = 1 FROM calblue_agent.roster));
SELECT pg_temp.assert_ok((SELECT balance = 70 AND charges_total = 100
                                AND payments_total = 30 FROM calblue_agent.accounts));
SELECT pg_temp.assert_ok((SELECT sum(amount) = 70 AND count(*) = 3 FROM calblue_agent.ledger));
SELECT pg_temp.assert_ok((SELECT NOT bool_or(to_jsonb(r)::text LIKE '%PRIVATE%')
                          FROM calblue_agent.roster r));
SELECT pg_temp.assert_ok((SELECT array_agg(column_name::text ORDER BY ordinal_position)
  = ARRAY['player_id','account_id','display_name','preferred_number','default_positions','verification_status']
  FROM information_schema.columns WHERE table_schema = 'calblue_agent' AND table_name = 'roster'));
SELECT pg_temp.expect_denied('SELECT * FROM public.players');
SELECT pg_temp.expect_denied('SELECT * FROM public.profiles');
SELECT pg_temp.expect_denied('SELECT * FROM auth.users');
SELECT pg_temp.expect_denied('SELECT * FROM public.charges');
SELECT pg_temp.expect_denied('SELECT * FROM public.payments');
SELECT pg_temp.expect_denied('UPDATE calblue_agent.roster SET display_name = ''changed''');
SELECT pg_temp.expect_denied('DELETE FROM public.charges');
SELECT pg_temp.expect_denied('INSERT INTO public.payments(account_id,amount) VALUES (''a1111111-1111-4111-8111-111111111111'',10)');
SELECT pg_temp.expect_denied('CREATE TABLE calblue_agent.injected(id int)');
SELECT pg_temp.expect_denied('SET ROLE authenticated');
SELECT pg_temp.expect_denied('SET ROLE service_role');
SELECT pg_temp.expect_denied('SELECT public.close_billing_period(null)');
-- A direct SQL caller can set claims; that must not confer function/table grants.
SELECT set_config('request.jwt.claims', '{"app_metadata":{"roles":["admin"]}}', true);
SELECT pg_temp.expect_denied('SELECT public.close_billing_period(null)');
RESET SESSION AUTHORIZATION;
SET LOCAL SESSION AUTHORIZATION anon;
SELECT pg_temp.expect_denied('SELECT * FROM calblue_agent.accounts');
RESET SESSION AUTHORIZATION;
SET LOCAL SESSION AUTHORIZATION authenticated;
SELECT pg_temp.expect_denied('SELECT * FROM calblue_agent.accounts');
RESET SESSION AUTHORIZATION;

-- Revocation must block even the same existing session after it has read data.
REVOKE ALL ON ALL TABLES IN SCHEMA calblue_agent FROM calblue_henry_agent;
REVOKE ALL ON SCHEMA calblue_agent FROM calblue_henry_agent;
SET LOCAL SESSION AUTHORIZATION calblue_henry_agent;
SELECT pg_temp.expect_denied('SELECT * FROM calblue_agent.accounts');
RESET SESSION AUTHORIZATION;
ROLLBACK;
SELECT 'PASS: scoped reads, accounting, sensitive-field exclusion, write denial, escalation denial and revocation' AS result;
