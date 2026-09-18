# Migration 0004 — administrator player verification

Issue #32 adds two nullable decision columns to `players`, a pending-queue index, an additional
direct-write guard and two checked RPCs. It does not create users, assign roles, import players,
backfill decisions, or apply itself. Released migrations 0001–0003 are unchanged.

The generated [0004 SQL](migrations/0004_player_verification.sql) comes from section 11 of
`docs/design/schema.sql`. Do not execute the entire draft schema: sections 9 and 10 are still
future work. Apply 0004 **once**, with migration tracking; its BEGIN/COMMIT wrapper is atomic,
not permission to replay it. Do not remove failed statements and continue with half a migration.

## 1. Choose the project and verify prerequisites

For execution tests use an **empty, disposable Supabase scratch project** with no real accounts
or player data, no seed, and migrations 0001–0003 each applied once. The configured real-member
project already contains an account and identity: never run the synthetic smoke scripts there.

Deployment to a real project is a separate owner decision. Confirm its project URL in the
dashboard, use its database owner (`postgres`) in SQL Editor, and arrange an appropriate backup
before a schema change. No password, service key, JWT or email callback should be pasted into a PR.

Run this **read-only metadata preflight**, applicable to both a prepared scratch project and a
real project before an explicitly approved deployment. Every result should be `true`:

```sql
with expected(name) as (
  values ('profiles'), ('players'), ('venues'), ('clubs'), ('teams'), ('competitions'),
    ('games'), ('role_grants'), ('competition_registrations'), ('game_registrations'),
    ('fee_schedules'), ('billing_periods'), ('charges'), ('payments'),
    ('period_player_summaries'), ('period_account_summaries'), ('audit_log')
), relations as (
  select e.name, c.oid, c.relkind, c.relrowsecurity, c.relowner
  from expected e
  left join pg_catalog.pg_namespace n on n.nspname = 'public'
  left join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = e.name
)
select
  count(oid) = 17 and bool_and(relkind = 'r') as tables_ready,
  count(oid) = 17 and bool_and(relrowsecurity) as rls_ready,
  count(oid) = 17 and bool_and(pg_catalog.pg_get_userbyid(relowner) = current_user)
    as owner_session,
  to_regprocedure('public.guard_verification()') is not null
    and to_regprocedure('public.is_admin()') is not null
    and to_regprocedure('public.lock_billing()') is not null as helpers_ready,
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'players'
      and column_name in ('decided_by', 'decided_at')
  ) as new_columns_absent,
  to_regprocedure('public.guard_player_verification_decision()') is null
    and to_regprocedure('public.list_player_verifications(text,integer)') is null
    and to_regprocedure('public.decide_player_verifications(uuid[],timestamptz[],text,text)') is null
    as new_functions_absent,
  to_regclass('public.players_pending_verification') is null as new_index_absent,
  not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = to_regclass('public.players')
      and tgname = 'players_verification_decision_guard' and not tgisinternal
  ) as new_trigger_absent,
  not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = to_regclass('public.players') and conname in
      ('players_verification_decision_pair', 'players_pending_without_decision')
  ) as new_constraints_absent
from relations;
```

If anything is false, stop. A new object may mean 0004 is already applied; missing prerequisites
or different owners need investigation, not rerunning released SQL or dropping existing objects.
These are metadata checks, not a proof that every existing function still matches its release.

Then run this separate **read-only, count-only data check**. It returns no names, identifiers or
private notes. Expected: `invalid_verification_timestamps = 0`.

```sql
select count(*) as invalid_verification_timestamps
from public.players
where not isfinite(created_at) or not isfinite(updated_at)
   or created_at < timestamptz '0001-01-01 00:00:00+00'
   or updated_at < timestamptz '0001-01-01 00:00:00+00'
   or created_at >= timestamptz '10000-01-01 00:00:00+00'
   or updated_at >= timestamptz '10000-01-01 00:00:00+00';
```

Before 0004, direct client inserts could supply arbitrary `updated_at` values. New client inserts
normalize that value, but there is deliberately no silent repair of historical data. If the count
is nonzero, stop for explicit owner review/correction before using the strict queue client.

## 2. Apply only the new migration

After the owner approves the target and the preflight passes, run the **entire unchanged**
`supabase/migrations/0004_player_verification.sql` once in the owner SQL session (or through the
project's established migration workflow). Record its application. Do not rerun 0001–0003 or seed.

Expected: no SQL error. Then run this **read-only installed-metadata check**, all `true`:

```sql
select
  (select count(*) = 2 from information_schema.columns
    where table_schema = 'public' and table_name = 'players'
      and column_name in ('decided_by', 'decided_at')) as decision_columns_exist,
  (select count(*) = 2 from pg_catalog.pg_constraint
    where conrelid = 'public.players'::regclass and conname in
      ('players_verification_decision_pair', 'players_pending_without_decision'))
    as decision_constraints_exist,
  exists (select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.players'::regclass
      and tgname = 'players_verification_decision_guard' and tgenabled = 'O')
    as decision_guard_enabled,
  to_regclass('public.players_pending_verification') is not null as queue_index_exists,
  has_function_privilege('authenticated',
    'public.list_player_verifications(text,integer)', 'EXECUTE')
    and has_function_privilege('authenticated',
    'public.decide_player_verifications(uuid[],timestamptz[],text,text)', 'EXECUTE')
    as authenticated_rpc_access,
  not has_function_privilege('anon',
    'public.list_player_verifications(text,integer)', 'EXECUTE')
    and not has_function_privilege('anon',
    'public.decide_player_verifications(uuid[],timestamptz[],text,text)', 'EXECUTE')
    as anonymous_rpc_denied,
  not has_function_privilege('authenticated',
    'public.guard_player_verification_decision()', 'EXECUTE') as guard_not_callable;
```

Stop on any false result or SQL error; a missing RPC can make the privilege check report an error
instead of returning false. Do not repair that by granting broader access or replaying migrations.

If metadata is correct but PostgREST temporarily reports a missing RPC, allow its schema cache
to refresh. The owner can request a reload with `NOTIFY pgrst, 'reload schema';`; this is not a
reason to reapply the migration. A non-admin refusal is expected, not a cache problem.

## 3. Run execution checks on the empty scratch project only

1. Run [0004_player_verification_smoke.sql](tests/0004_player_verification_smoke.sql) **in full**
   as the database owner. Its preflight requires empty Auth users and all 17 application tables;
   do not bypass that guard. Expected notice: `0004 player verification smoke passed; rolling
   back all fixtures.` The script ends with ROLLBACK.
2. Run [0004_player_verification_isolation_smoke.sql](tests/0004_player_verification_isolation_smoke.sql)
   in full in a fresh owner SQL transaction. Expected notice: `0004 verification isolation smoke
   passed; rolling back.` It checks that unsupported REPEATABLE READ fails before work proceeds.

The main smoke creates only invented temporary test accounts/players and simulated JWT claims,
then rolls everything back. Temporary helper grants also roll back. If an error leaves a transaction
open, run `ROLLBACK;` before investigating. Do not continue after an error or copy individual fixture
inserts into a real project. These tests are not real Auth login, PostgREST or concurrent-session tests.

Coverage includes anonymous/non-admin refusal even for no matches/empty batches, direct member
verification and metadata tampering, bounded literal name search and pagination, safe projection,
bulk approval and database stamps, stale/missing/terminal conflicts, required rejection reasons,
direct-admin stamping, insert timestamp normalization and ordinary owner/guardian edits retaining
decision metadata. Unknown legacy rejection metadata and notes remain unchanged.

The SQL runs only when the owner chooses to execute it. Python structural tests and CI do not
install a database or establish a live RLS/transaction result.

## 4. Browser and real-session verification

Follow [the app review checklist](../app/verification.md#owner-review-checklist) with approved
test accounts and invented non-sensitive data. An admin role is not required for `/app/tests/`
because that suite uses injected doubles. Real `#/admin/verify` needs a valid admin JWT.

If no approved administrator exists, stop and agree on an exact-account owner-controlled bootstrap
separately. Do not edit browser `user_metadata`, paste tokens, use a service key in the frontend,
grant admin to every account, or reset an existing user's roles for testing. Use **Refresh my access**
after a legitimate role change. Approving an identity never grants the `player` account role.

Also test a stale decision in two real admin tabs and confirm that a mixed batch containing a stale
record leaves every other selected record unchanged. True overlapping transactions and lock waits
are a separate runtime check, not proven by the sequential smoke file.

## Security/compatibility notes

- The read RPC is SECURITY INVOKER with an explicit admin check; existing RLS still applies.
  The decision RPC is SECURITY DEFINER, explicitly checks the JWT, calls the existing billing lock
  before player locks and verifies pending status/version for the whole batch.
- The new trigger is SECURITY INVOKER. It runs alongside the unchanged ownership/DOB guard,
  rejects forged metadata and stamps new decisions from the authenticated actor and database clock.
  Ordinary player/guardian detail edits preserve a decision. Direct admin API decisions are guarded
  too; terminal decisions cannot be overwritten through this workflow.
- A database-owner session with no JWT actor retains the existing privileged maintenance boundary.
  Exposed RPCs **never** treat their function owner as an authenticated administrator. Do not use
  the maintenance exception to bypass pending-review semantics in normal application code.
- Decision metadata is nullable only to preserve unknown history. No historical actor/date is
  guessed, and an old rejection without a note does not prevent an ordinary member detail edit.
- This records decision attribution, not a general player-edit audit history. No full player row
  is copied into audit JSON. Member-visible decision notes must not contain internal-only remarks.
- Existing JWT expiry/refresh semantics remain: a newly revoked role is not guaranteed to invalidate
  a previously issued token immediately. UI cleanup cannot roll back an already accepted write.
