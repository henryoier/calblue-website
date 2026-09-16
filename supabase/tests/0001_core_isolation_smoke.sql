-- Manual isolation-guard test after 0001_core.sql on a DISPOSABLE scratch Supabase project.
-- Run as the database owner, never in production. With psql, use -v ON_ERROR_STOP=1.
-- No passwords/API keys; no fixtures need to exist. Expected isolation errors must occur before
-- foreign-key checks or game lookups. All changes roll back; no backend execution by the agent.
-- SERIALIZABLE is conservatively rejected by the same guard, but is not tested by this script.
-- This tests rejection of unsupported isolation, not two-session concurrency at READ COMMITTED.

BEGIN ISOLATION LEVEL REPEATABLE READ;

DO $$
DECLARE insert_rejected boolean := false; promotion_rejected boolean := false;
BEGIN
  IF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'core isolation smoke: expected a REPEATABLE READ transaction';
  END IF;

  BEGIN
    INSERT INTO public.game_registrations (id, game_id, player_id) VALUES
      ('c0250000-0000-4000-8000-000000019001',
       'c0250000-0000-4000-8000-000000019002',
       'c0250000-0000-4000-8000-000000019003');
  EXCEPTION WHEN SQLSTATE '0A000' THEN
    IF SQLERRM <> 'registration_requires_read_committed' THEN RAISE; END IF;
    insert_rejected := true;
  END;
  IF NOT insert_rejected THEN
    RAISE EXCEPTION 'core isolation smoke: registration insert did not reject REPEATABLE READ';
  END IF;

  BEGIN
    PERFORM public.promote_from_waitlist('c0250000-0000-4000-8000-000000019002'::uuid);
  EXCEPTION WHEN SQLSTATE '0A000' THEN
    IF SQLERRM <> 'registration_requires_read_committed' THEN RAISE; END IF;
    promotion_rejected := true;
  END;
  IF NOT promotion_rejected THEN
    RAISE EXCEPTION 'core isolation smoke: promotion did not reject REPEATABLE READ';
  END IF;

  RAISE NOTICE 'Core isolation guards rejected both entry points with the expected error; rolling back.';
END;
$$;
ROLLBACK;
-- No success statement after ROLLBACK: an earlier aborted transaction must not look successful.
