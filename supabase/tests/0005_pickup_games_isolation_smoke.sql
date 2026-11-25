-- Owner-run only on the same disposable project with 0001–0005 installed.
-- Synthetic claims need no fixture account: writes reject isolation before
-- reading a profile/game or attempting a row write. This is not a race test.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT set_config('request.jwt.claims',
  '{"sub":"c0330000-0000-4000-8000-000000000101","role":"authenticated","app_metadata":{"roles":["admin"]}}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','',true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE statement text; rejected boolean; actual_message text;
BEGIN
  FOREACH statement IN ARRAY ARRAY[
    'SELECT * FROM public.save_pickup_game(NULL,NULL,''{}''::jsonb)',
    'SELECT * FROM public.transition_pickup_game(''c0330000-0000-4000-8000-000000000701'',now(),''cancel'',''Synthetic reason'')'
  ] LOOP
    rejected := false;
    BEGIN
      EXECUTE statement;
    EXCEPTION WHEN SQLSTATE '0A000' THEN
      GET STACKED DIAGNOSTICS actual_message=MESSAGE_TEXT;
      IF actual_message <> 'billing_requires_read_committed' THEN RAISE EXCEPTION 'Unexpected isolation error'; END IF;
      rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Expected READ COMMITTED requirement'; END IF;
  END LOOP;
  RAISE NOTICE '0005 pickup games isolation smoke passed; rolling back.';
END $$;
RESET ROLE;
ROLLBACK;
