-- Human-run JWT/role-guard test after 0001, 0002 AND 0003 on an EMPTY,
-- DISPOSABLE Supabase project. Run the complete file as postgres/database owner.
-- This uses synthetic JWT claims in a privileged SQL session; it does not test
-- Auth token signing, delivery, browser refresh or the PostgREST gateway.
-- No credentials or real member data. All rows/helpers/grants roll back;
-- audit identity sequence values can advance despite rollback.

BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','',true);

CREATE FUNCTION pg_temp.jwt_assert(condition boolean, description text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS JWT smoke assertion failed: %', description;
  END IF;
END;
$$;

DO $$
BEGIN
  PERFORM pg_temp.jwt_assert(NOT EXISTS (SELECT 1 FROM public.profiles), 'empty scratch profiles');
  PERFORM pg_temp.jwt_assert(NOT EXISTS (SELECT 1 FROM public.audit_log), 'empty scratch audit');
  -- Test helpers are invokers, not a route around the production policies.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated',
    (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()));
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.jwt_assert(boolean,text) TO authenticated;

INSERT INTO auth.users(id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
VALUES ('c0270000-0000-4000-8000-000000000901', 'rls-jwt-smoke@example.invalid',
  '{"display_name":"Synthetic JWT member","roles":["admin"]}'::jsonb,
  '{"provider":"email","fixture":"rls-jwt"}'::jsonb, now(), now());
SELECT pg_temp.jwt_assert(
  (SELECT cardinality(roles)=0 FROM public.profiles WHERE id='c0270000-0000-4000-8000-000000000901'),
  'signup metadata cannot bootstrap an admin');
UPDATE public.profiles SET roles=ARRAY['player']
WHERE id='c0270000-0000-4000-8000-000000000901';

SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":["player"]}}', true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.jwt_assert(public.has_role('player') AND NOT public.is_admin(), 'initial member token');
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    UPDATE public.profiles SET roles=ARRAY['admin']
    WHERE id='c0270000-0000-4000-8000-000000000901';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'RLS JWT smoke: self-promotion was not rejected'; END IF;
END;
$$;
RESET ROLE;

-- A trusted owner changes roles. An already-issued JWT is intentionally stale.
UPDATE public.profiles SET roles=ARRAY['player','admin']
WHERE id='c0270000-0000-4000-8000-000000000901';
SELECT pg_temp.jwt_assert(
  (SELECT raw_app_meta_data->'roles'='["player","admin"]'::jsonb
     AND raw_app_meta_data->>'fixture'='rls-jwt'
   FROM auth.users WHERE id='c0270000-0000-4000-8000-000000000901'),
  'trusted role change mirrors claims without deleting other metadata');
SET LOCAL ROLE authenticated;
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'old JWT does not gain a new role implicitly');
SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":["player","admin"]}}', true);
SELECT pg_temp.jwt_assert(public.is_admin(), 'refreshed JWT gains the assigned admin role');
RESET ROLE;

UPDATE public.profiles SET roles=ARRAY['player']
WHERE id='c0270000-0000-4000-8000-000000000901';
SET LOCAL ROLE authenticated;
SELECT pg_temp.jwt_assert(public.is_admin(), 'revocation also waits for a new token or token expiry');
SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":["player"]}}', true);
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'new JWT applies role revocation');

SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","user_metadata":{"roles":["admin"]}}', true);
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'user-controlled metadata is not authority');
SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":["developer","treasurer","coach"]}}', true);
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'non-admin roles do not imply admin');
SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":"admin"}}', true);
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'malformed role scalar fails closed');
SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":null}}', true);
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'null role claim fails closed');
SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":["admin",7]}}', true);
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'mixed-type role array fails closed');
SELECT pg_temp.jwt_assert(public.has_role(NULL) IS FALSE, 'null role request cannot bypass a negative guard');
SELECT set_config('request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"roles":["admin"]}}', true);
SELECT pg_temp.jwt_assert(NOT public.is_admin(), 'a role claim without an account is not authorized');
RESET ROLE;

-- Empty search_path still implicitly searches the temporary schema for tables.
-- A hostile pg_class must not make an invoker guard mistake a client for its owner.
CREATE TEMP TABLE pg_class(oid oid, relowner oid) ON COMMIT DROP;
INSERT INTO pg_temp.pg_class(oid,relowner)
VALUES ('public.profiles'::regclass,
  (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated'));
GRANT SELECT ON TABLE pg_temp.pg_class TO authenticated;
-- Force guard queries to resolve names again instead of reusing a pre-spoof plan.
DISCARD PLANS;
SELECT set_config('request.jwt.claims',
  '{"sub":"c0270000-0000-4000-8000-000000000901","role":"authenticated","app_metadata":{"roles":["player"]}}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    UPDATE public.profiles SET roles=ARRAY['admin']
    WHERE id='c0270000-0000-4000-8000-000000000901';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'RLS JWT smoke: temporary catalog spoof bypassed role guard'; END IF;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  RAISE NOTICE 'JWT source, guard and refresh-model assertions passed; rolling back. Real Auth refresh remains untested.';
END;
$$;
ROLLBACK;
-- No success query after ROLLBACK: it could conceal an earlier aborted transaction.
