# Billing migration 0002

Issue #26 / PR #80 adds the database foundation for recorded payments and quarterly billing.
It does not process payments, send invoices, expose a browser RPC, or add a website screen.
The configured CalBlue project is not changed by CI or by the coding agent.

## What is installed

- Seven tables: fee schedules, billing periods, charges, payments, player/account period
  summaries and audit history.
- Three caller-security views: account balances, account ledger and the opt-in verified roster.
- Fee resolution, retry-safe attendance finalization, period assignment and quarterly close.
- Guards that preserve financial facts, locked attendance and frozen historical summaries.

All new tables have RLS without client policies. Table/view/sequence privileges and helper
execution are revoked from `PUBLIC`, `anon` and `authenticated`. Definer helpers use fixed empty
search paths; views use PostgreSQL 15+ `security_invoker`. Issue #27 must deliberately add minimum
grants and authorization policies; do not grant all privileges to make a screen work. Internal
writers and lock helpers must not become public RPCs, and snapshot tables need SELECT-only client
access. A database owner remains privileged and can administer the schema.

## Rules corrected from the draft

- Finalizing a completed game twice is a no-op on the second call, including after its period
  closes. Cancelled games do not bill; draft/published games must first become completed.
- Only registered players/keepers incur playing or no-show fees. Coaches, volunteers, waitlisted
  or cancelled registrations are excluded. Zero fee overrides remain zero, not a fallback.
- A direct trusted `completed` → `locked` update uses the same charge writer as the finalization
  function. Changing billing-relevant game facts in that transition is rejected.
- Fee precedence stays game override → competition default → dated schedule → zero. Equal schedule
  candidates use explicit scope/date/creation-time/ID tie-breakers.
- Charge identity, payer, subject, source, amount, date and other original facts cannot be edited
  or deleted. Only an initial valid period assignment and a reasoned, one-way void are allowed.
  Payments are also immutable facts; corrections use refund/replacement records. Historical payer
  ownership is frozen rather than silently following a later guardian/account change.
- Period assignment must match the financial date and cannot be removed or moved after assignment.
  Periods cannot overlap, change dates after creation, or close out of chronological order.
- Closing requires every non-draft game in the window to be finalized or cancelled. Drafts do not
  contribute attendance and cannot later become played historical games in a sealed date range.
- Closure writes separate player-attendance and payer-money snapshots. Attendance is period-scoped;
  account balances carry forward. Direct trusted period-status updates run the same checks/writer.
- Closed periods cannot reopen. All financial dates through the latest closed period end—including
  earlier gaps—are sealed, so backdated writes cannot alter an issued opening balance. Historical
  corrections must be new credits/refunds dated after that cutoff.
- Snapshots and audit records cannot be updated/deleted, and guarded tables cannot be truncated
  through ordinary DML. Owner-only direct inserts are not an application authorization mechanism.

`charges.player_id` remains nullable and exactly one of `player_id` / `entry_id` is required.
The reserved entry UUID has **no foreign key until the hosted-tournament migration** creates its
table. No entry-fee workflow is authorized here; validate real entries before granting that future
workflow access. The smoke test's entry UUID is intentionally synthetic.

## Locking and limits

Billing writes require `READ COMMITTED`. A shared transaction-level advisory lock serializes
ordinary financial changes and relevant account/game/registration writes; finalization also takes
0001's per-game lock. This prioritizes consistency over write throughput for a small club.
Other isolation modes fail with `billing_requires_read_committed` (`0A000`).

Sequential smoke tests do **not** prove race safety. Before enabling registration/billing clients,
test concurrent finalization, registration/attendance edits, payment recording and quarter closure
in independent transactions. Privileged maintenance that takes row locks first or directly calls
0001's owner-only `promote_from_waitlist` can have a different lock order and require deadlock
retries. Direct owner DDL, disabled triggers and owner-written snapshots are outside the client
security boundary. Do not infer complete production or authorization validation from these checks.

Late-cancellation penalties, eligibility/deadline workflows, invoicing UI, payment processing,
member access policies and hosted-tournament validation remain later issues.

## Source and automated checks

Only canonical `docs/design/schema.sql` sections 4–6 and 8 are emitted as 0002. Do not run the whole
design draft. Migration 0001 is already released and remains byte-identical. SQL is an atomic,
one-time installation, not replay-idempotent.

```bash
python3 scripts/build_migrations.py
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 -m unittest discover -s tests -v
```

The generator now requires 0001 and 0002 by default. The linter checks documented structure,
RLS/ACLs, fixed paths, invoker views and key constraints; it does not execute PostgreSQL or prove
accounting semantics. CI remains offline with respect to Supabase.

## Manual test — not yet run

Use the **empty disposable Supabase project where 0001 passed**, not the production/configured
CalBlue project. If starting a fresh test project, apply 0001 and run its two smoke files first.
Do not rerun 0001 after it has succeeded, and do not run its core-only smoke scripts after 0002.

In SQL Editor, use the `postgres` / database-owner role. Each file below belongs in a **separate
new query in the same project**. Copy the entire file, clear any partial selection and run it.

1. Run [migrations/0002_money.sql](migrations/0002_money.sql) **once**.
   Expected: no SQL errors; seven tables are added, for 17 core/money tables total, plus three views.
2. Run [tests/0002_money_smoke.sql](tests/0002_money_smoke.sql).
   It verifies access restrictions, fee precedence, duplicate finalization, immutable charges and
   payments, one-way voids, period overlap/closure guards, period-scoped family billing, carry-forward
   balances, frozen history and audit evidence. Expected: no unhandled SQL errors.
3. Run [tests/0002_money_isolation_smoke.sql](tests/0002_money_isolation_smoke.sql).
   It asserts that privileged entry points and ordinary payment DML reject `REPEATABLE READ`.
   Expected: no unhandled SQL errors; the script catches and verifies the intended failures.

Stop on any SQL error and report the file name/error; do not drop tables, weaken permissions or
blindly rerun a migration. Successful smoke scripts roll back synthetic users/rows and temporary
helpers, leaving the installed schema intact. Audit identity sequence numbers may advance even
though rows roll back. Both scripts emit a success notice **before** rollback; some dashboards
hide notices. A generic no-rows result is only meaningful if the entire file ran without errors.

Report these results in PR #80, using the revision actually tested:

```text
Tested PR commit: <full commit SHA>
Environment: disposable Supabase project with 0001 already applied
0002_money.sql: not run
0002_money_smoke.sql: not run
0002_money_isolation_smoke.sql: not run
SQL error, if any: <exact text, excluding private information>
Two-session concurrency: not tested
```

No database password/private key needs to be shared. PR #80 addresses issue #26 until this manual
verification is confirmed; it should resolve the issue only when the verified PR is merged.
