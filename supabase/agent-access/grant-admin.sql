-- Owner-run for an existing VERIFIED Henry or dedicated agent Auth account.
-- First run, in the same session:
-- SELECT set_config('calblue.target_account_id', 'EXACT-VERIFIED-AUTH-UUID', false);
-- This creates no account/credential and does not modify any RLS policy.
BEGIN;
DO $$
DECLARE
  target_id uuid := nullif(current_setting('calblue.target_account_id', true), '')::uuid;
  auth_email text;
  profile_email text;
  confirmed_at timestamptz;
BEGIN
  IF current_user <> pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
                                                WHERE oid = 'public.profiles'::regclass)) THEN
    RAISE EXCEPTION 'Run as the profiles table owner';
  END IF;
  IF target_id IS NULL THEN RAISE EXCEPTION 'Exact target account UUID is required'; END IF;
  SELECT email, email_confirmed_at INTO STRICT auth_email, confirmed_at
    FROM auth.users WHERE id = target_id FOR UPDATE;
  IF confirmed_at IS NULL OR nullif(auth_email, '') IS NULL THEN
    RAISE EXCEPTION 'Target Auth email must be verified';
  END IF;
  SELECT email::text INTO STRICT profile_email FROM public.profiles
    WHERE id = target_id FOR UPDATE;
  IF lower(auth_email) IS DISTINCT FROM lower(profile_email) THEN
    RAISE EXCEPTION 'Auth/profile email mismatch';
  END IF;
  UPDATE public.profiles SET roles = array_append(roles, 'admin')
    WHERE id = target_id AND NOT ('admin' = ANY(roles));
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = target_id
    AND raw_app_meta_data->'roles' @> '["admin"]'::jsonb) THEN
    RAISE EXCEPTION 'Admin claim synchronization failed';
  END IF;
END $$;
COMMIT;
-- Refresh the target's Auth session before testing administrator access.
