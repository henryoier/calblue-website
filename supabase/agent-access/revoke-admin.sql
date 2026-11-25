-- Owner-run. Set calblue.target_account_id exactly as in grant-admin.sql.
-- Removes only admin. Existing JWTs may keep old claims until expiry;
-- revoke/refresh Auth sessions separately and verify actual denial.
BEGIN;
DO $$
DECLARE
  target_id uuid := nullif(current_setting('calblue.target_account_id', true), '')::uuid;
BEGIN
  IF current_user <> pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
                                                WHERE oid = 'public.profiles'::regclass)) THEN
    RAISE EXCEPTION 'Run as the profiles table owner';
  END IF;
  IF target_id IS NULL THEN RAISE EXCEPTION 'Exact target account UUID is required'; END IF;
  -- Same lock order as grant-admin to serialize simultaneous changes.
  PERFORM id FROM auth.users WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target Auth account does not exist'; END IF;
  PERFORM id FROM public.profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target profile does not exist'; END IF;
  UPDATE public.profiles SET roles = array_remove(roles, 'admin') WHERE id = target_id;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = target_id
    AND raw_app_meta_data->'roles' @> '["admin"]'::jsonb) THEN
    RAISE EXCEPTION 'Admin claim removal failed';
  END IF;
END $$;
COMMIT;
