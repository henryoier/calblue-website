-- SUPERSEDED DEFAULT: Henry and his agent now require club admin access.
-- See README.md and grant-admin.sql. This is the optional historical read-only proposal.
-- Optional owner-run setup after migrations 0001-0004. Apply ONCE.
-- No password, LOGIN, API exposure, or new member/admin role is created here.
-- An existing role/schema causes an atomic failure rather than widening access.
BEGIN;
CREATE ROLE calblue_henry_agent NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE calblue_henry_agent SET statement_timeout = '15s';
ALTER ROLE calblue_henry_agent SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE calblue_henry_agent SET search_path = calblue_agent, pg_catalog;
-- Convenience only: ACLs below enforce read-only even if this setting is changed.
ALTER ROLE calblue_henry_agent SET default_transaction_read_only = on;

CREATE SCHEMA calblue_agent;
REVOKE ALL ON SCHEMA calblue_agent FROM PUBLIC, anon, authenticated;

-- Deliberate owner-rights views: only these selected columns cross the boundary.
-- Do not change to invoker views, grant base-table access, or expose this schema
-- through the Data API. Member RLS and profiles.roles remain unchanged.
CREATE VIEW calblue_agent.roster WITH (security_barrier = true) AS
SELECT id AS player_id, payer_account_id AS account_id, display_name,
       preferred_number, default_positions, verification_status
  FROM public.players;

CREATE VIEW calblue_agent.accounts WITH (security_barrier = true) AS
SELECT a.id AS account_id, a.display_name, a.email::text AS email,
       coalesce(c.total, 0) AS charges_total,
       coalesce(p.total, 0) AS payments_total,
       coalesce(c.total, 0) - coalesce(p.total, 0) AS balance
  FROM public.profiles a
  LEFT JOIN LATERAL (
    SELECT sum(amount) AS total FROM public.charges
     WHERE account_id = a.id AND voided_at IS NULL
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT sum(amount) AS total FROM public.payments WHERE account_id = a.id
  ) p ON true;

-- Intentionally omit descriptions, payment notes and external references: free
-- text can contain private contact/bank data. Negative payments remain visible
-- so refunds/corrections do not disappear from the balance.
CREATE VIEW calblue_agent.ledger WITH (security_barrier = true) AS
SELECT id AS source_id, account_id, player_id, charge_date AS entry_date,
       'charge'::text AS direction, kind AS entry_type, amount
  FROM public.charges WHERE voided_at IS NULL
UNION ALL
SELECT id, account_id, player_id, payment_date, 'payment', method, -amount
  FROM public.payments;

REVOKE ALL ON ALL TABLES IN SCHEMA calblue_agent FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA calblue_agent TO calblue_henry_agent;
GRANT SELECT ON calblue_agent.roster, calblue_agent.accounts, calblue_agent.ledger
  TO calblue_henry_agent;
-- No default grants: new views/tables must be authorized individually.

-- PUBLIC grants apply to all logins, including NOINHERIT roles. Abort if the
-- deployment has drifted into broad table privileges or role escalation.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members
              WHERE member = 'calblue_henry_agent'::regrole) THEN
    RAISE EXCEPTION 'Agent must not belong to another database role';
  END IF;
  FOR r IN SELECT c.oid, n.nspname, c.relname
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'auth', 'storage')
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f') LOOP
    IF has_table_privilege('calblue_henry_agent', r.oid,
                          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Unexpected inherited table privilege: %.%', r.nspname, r.relname;
    END IF;
    IF has_any_column_privilege('calblue_henry_agent', r.oid,
                               'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Unexpected inherited column privilege: %.%', r.nspname, r.relname;
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid, p.proname
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef LOOP
    IF has_function_privilege('calblue_henry_agent', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected executable privileged app function: %', r.proname;
    END IF;
  END LOOP;
END $$;
COMMIT;
