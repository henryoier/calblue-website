-- Owner-run only on the same disposable project with all four migrations.
-- Synthetic claims need no fixture account: isolation fails before profile reads.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT set_config('request.jwt.claims',
  '{"sub":"c0320000-0000-4000-8000-000000000101","role":"authenticated","app_metadata":{"roles":["admin"]}}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','',true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE rejected boolean := false; actual_message text;
BEGIN
  BEGIN
    PERFORM public.decide_player_verifications(
      ARRAY['c0320000-0000-4000-8000-000000000201'::uuid],
      ARRAY[now()], 'verified', NULL);
  EXCEPTION WHEN SQLSTATE '0A000' THEN
    GET STACKED DIAGNOSTICS actual_message=MESSAGE_TEXT;
    IF actual_message <> 'billing_requires_read_committed' THEN RAISE EXCEPTION 'Unexpected isolation error'; END IF;
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Expected READ COMMITTED requirement'; END IF;
  RAISE NOTICE '0004 verification isolation smoke passed; rolling back.';
END $$;
RESET ROLE;
ROLLBACK;
