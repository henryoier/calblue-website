-- Human-run isolation-guard test after migrations 0001 AND 0002, as the
-- database owner on a DISPOSABLE scratch project. Run the complete file.
-- No fixtures, credentials or production writes. Nothing commits.
-- Source review is not a database execution test. This does not establish
-- two-session correctness at READ COMMITTED or test SERIALIZABLE execution.

BEGIN ISOLATION LEVEL REPEATABLE READ;

DO $$
DECLARE statement text; rejected boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'money isolation smoke: expected REPEATABLE READ';
  END IF;
  FOREACH statement IN ARRAY ARRAY[
    'SELECT public.finalise_game_attendance(''c0260000-0000-4000-8000-000000009999''::uuid)',
    'SELECT public.close_billing_period(''c0260000-0000-4000-8000-000000009999''::uuid)',
    'UPDATE public.payments SET note = note WHERE false'
  ] LOOP
    rejected := false;
    BEGIN
      EXECUTE statement;
    EXCEPTION WHEN SQLSTATE '0A000' THEN
      IF SQLERRM <> 'billing_requires_read_committed' THEN RAISE; END IF;
      rejected := true;
    END;
    IF NOT rejected THEN
      RAISE EXCEPTION 'money isolation smoke: unsupported isolation was accepted';
    END IF;
  END LOOP;
  RAISE NOTICE 'Money entry points and statement-level DML rejected unsupported isolation; rolling back.';
END;
$$;
ROLLBACK;
-- No success statement after ROLLBACK: do not conceal an earlier failure.
