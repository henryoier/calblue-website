# CalBlue database migrations

Apply migrations in order, once each:

1. [0001_core.sql](migrations/0001_core.sql): issue #25 / merged PR #79. Its released bytes are unchanged.
2. [0002_money.sql](migrations/0002_money.sql): issue #26 / merged PR #80. Read the
   [billing migration and test guide](0002-money.md) before running it.
3. [0003_rls.sql](migrations/0003_rls.sql): issue #27 / merged PR #81. Read the
   [access-policy migration and test guide](0003-rls.md).
4. [0004_player_verification.sql](migrations/0004_player_verification.sql): issue #32. Read the
   [player verification migration and test guide](0004-player-verification.md). This adds decision
   metadata and checked admin RPCs; it does not apply itself or grant anyone an admin role.
5. [0005_pickup_games.sql](migrations/0005_pickup_games.sql): issue #33. Read the
   [pickup migration and test guide](0005-pickup-games.md). Team-scoped checked pickup RPCs;
   no accounts, role grants, teams, venues or seed data are created.

Migrations 0001–0004 have owner-reported scratch verification; PR #107 recorded the results and
remaining manual coverage. Migration 0005 still needs its own owner-run execution checks. On a
database with 0001–0004 already installed, apply **0005 only**, once, after its preflight; do not
rerun earlier migrations. Existing scratch logins/admin roles also mean it is no longer an empty
database suitable for empty-only smoke scripts. The older installation sections below describe
their historical stages, not instructions to restart them. The **new 0005** guide separately permits
a narrowly guarded single-admin bootstrap-only disposable scratch state without resetting its
existing login, profile or audit history. It does not permit testing against real member data.

Issue #28 / PR #82 provides an optional [disposable development seed](seed.md).
It **commits demo data**, requires explicit
opt-in and an empty, idle scratch project, and must never run on production. If all three
migrations already passed, run only the seed/verification steps in that guide; do not reapply migrations.

If 0001 and 0002 already passed, continue with **0003 only**, then its two smoke files.
Do not rerun the earlier migrations or their deny-by-default smoke tests after 0003 installs
policies and grants. No production Supabase project is changed by CI or the coding agent.

If you already applied and tested 0001 for PR #79, keep that empty scratch project and continue
with 0002. **Do not rerun 0001.** Its core-only smoke scripts belong before 0002; the new billing
guards deliberately change the later runtime behavior, including the isolation error message.

Issue #25 added the **core schema file and its checks**, not a live database deployment or a
member-facing feature. Nothing in GitHub Actions applies SQL to Supabase. The public website
and `/app/` placeholder remain unchanged.

## What migration 0001 installs

| Area | Tables / behavior |
|---|---|
| Accounts and people | `profiles`, `players`; profile bootstrap on Auth signup, role metadata synchronization, at most one player identity per account, generated payer account, guest/guardian identities. |
| Fixtures and organizations | `venues`, `clubs`, `teams`, `competitions`, `games`; timezone-derived game date and update timestamps. |
| Participation | `role_grants`, `competition_registrations`, `game_registrations`; exactly one scope per role grant, unique season/match registration, separate registration status and attendance. |
| Internal slot handling | Serialized capacity checks, player/keeper-only counting, waitlist promotion when a counted slot is cancelled, deleted or changed to a nonplaying role. |

All ten tables have RLS enabled **without client policies**, and table privileges are revoked
from `PUBLIC`, `anon` and `authenticated`. Internal helper execution is also revoked from those
roles. The browser cannot read or write these tables just because migration 0001 was applied.
Owner/server access is still privileged; this is not a restriction on a database administrator.

No member/admin authorization policy, registration screen, eligibility check, signup deadline
workflow, attendance-finalization billing or money table is delivered by migration 0001. Those are
separate issues. Issue #27 must explicitly grant the minimum table/function privileges alongside its policies;
policies alone do not undo this migration's revocations. Do not re-grant all privileges to make a
later screen work.

## Source and generation

`docs/design/schema.sql` is the canonical source. Only sections 0–3 are emitted for issue #25.
Do not run the whole draft source as a migration; it also contains unimplemented later phases.

```bash
python3 scripts/build_migrations.py --target 0001_core.sql
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 -m unittest discover -s tests -v
```

Default generation/checking now requires **0001 through 0005**. Sections 11 and 12 append
forward-only verification and pickup changes without rewriting released sections. Future files require explicit repeatable
`--target` selections; they are not silently created as part of this issue. `--check` never writes
files or creates directories and fails if a required file is missing or different.

Generation is reproducible; **SQL execution is not replay-idempotent**. Apply 0001 once using
migration tracking, or once manually on a fresh scratch project and record that application.
The generated file has `BEGIN`/`COMMIT` so an error does not commit half an installation. Do not
add blanket `IF NOT EXISTS`, drop existing tables, or repeatedly paste a partially applied file
to conceal a failure. A subsequent schema change after release must be a new migration.

## Explicit corrections to the draft

These corrections are in the canonical source as well as the generated file; none is a hidden
generated-only divergence:

- Add the players-to-clubs foreign key after `clubs` exists; the original ordering failed on a
  fresh database.
- Add missing `updated_at` columns/touch triggers for mutable teams and role grants, and the
  missing clubs touch trigger.
- Derive `game_date` on every game write, using the named venue's timezone when present. A
  venue-less game uses its own timezone. A caller cannot override the derived date directly.
- Enforce exactly one competition/game/team target per role grant.
- Keep registration identity/game/player immutable; moves require a distinct registration.
- Count occupied slots as a trusted internal function so future RLS visibility cannot cause
  undercounting. Serialize registration changes, allow same-player upserts, and count only
  registered players/keepers. Registration changes and promotion require the default
  `READ COMMITTED` transaction isolation so counts get fresh snapshots after lock waits;
  other isolation modes fail with `registration_requires_read_committed` (`0A000`).
  In particular, an advisory lock alone cannot refresh a stale `REPEATABLE READ` snapshot.
- Promote only waiting players/keepers in published or registration-closed games with waitlists
  enabled and finite capacity. Cancelled/completed/locked/draft games are not auto-promoted.
  Order eligible candidates by `registered_at, id`; skip rows locked by another transaction and
  recheck status. A concurrently locked candidate may be skipped or leave a vacancy for a later
  registration operation; this is not a claim of strict FIFO under concurrent edits.
- Install RLS/table/function restrictions in 0001 rather than exposing tables until a later PR.
  Definer helpers have fixed empty search paths and qualified application-object references.

The slot helpers do not implement the full future registration workflow. Game-capacity edits,
deadline/eligibility rules and retries under concurrent transactions require the later feature
tests; they must not be inferred from a passing structural check.

## Core manual verification — before applying 0002

There is no local PostgreSQL/Docker environment. The Python linter checks a documented subset
of SQL structure and repository conventions; it cannot prove PostgreSQL execution, privileges,
trigger behavior, delivery of Auth emails or concurrency correctness.

1. Use a **fresh, disposable Supabase scratch project**, not a project containing member data.
   Keep it separate from the configured CalBlue project; these files have not been applied there.
   In the scratch dashboard, open **SQL Editor → New query** and use the `postgres` / database-owner
   role, not an `anon` or `authenticated` session. No database password is needed in the editor.
2. Review [migrations/0001_core.sql](migrations/0001_core.sql), copy the **complete file** into the
   query, clear any partial text selection, and run it **once**. Confirm there are no SQL errors.
   This commits the ten core tables and their restrictions to the scratch project. If it fails,
   stop and report the exact error; do not drop tables or loosen permissions to get past it.
3. Open another new query in the **same scratch project** and run the complete
   [tests/0001_core_smoke.sql](tests/0001_core_smoke.sql). Then use a separate new query for the
   complete [tests/0001_core_isolation_smoke.sql](tests/0001_core_isolation_smoke.sql).
   Do not run just a selected statement or paste all three files into one query. The core script
   checks synthetic accounts, constraints, triggers and restricted access; the isolation script
   checks rejection of `REPEATABLE READ`. Expected failures, including the duplicate-account
   identity check, are caught and asserted inside the scripts, so you should not see those as
   unhandled SQL errors.

   Both scripts must finish without errors; passing one does not compensate for failure in the
   other. Each emits a success **notice** before its final `ROLLBACK`; the dashboard may not show
   notices in its results pane. Do not mistake a standalone rollback or a generic no-rows message
   for proof that the entire script ran. Stop on any SQL error and report it. Successful smoke
   runs roll back synthetic users/data, temporary policies and grants; the schema installed in
   step 2 remains. Do not rerun the migration just to repeat a smoke test.
4. Record the tested commit and each run outcome in PR #79 using the template below. The scripts
   are reviewed but **not yet executed against PostgreSQL by the coding agent**. Do not paste
   passwords, private keys or real member data into the PR.
5. Separately verify two-session races on the scratch project before enabling registration:
   two players competing for one remaining slot, simultaneous cancellation/promotion, and
   cancellation of a candidate selected for promotion. Verify no overbooking or resurrection
   of a cancelled registration. Use two independent transactions; sequential smoke tests do
   not prove these properties. Avoid assuming that separate SQL Editor runs retain a session.

Copy this result template into the PR after testing and replace `not run` with the actual result:

```text
Tested PR commit: <full commit SHA>
Environment: fresh disposable Supabase project; database-owner role
0001_core.sql: not run
0001_core_smoke.sql: not run
0001_core_isolation_smoke.sql: not run
SQL error, if any: <exact error text, with private information removed>
Two-session concurrency: not tested
```

The project owner confirmed the scratch application and both core smoke scripts before PR #79
merged and issue #25 closed. This is user-reported verification, not a database run by the coding
agent. The owner also confirmed all three money files before PR #80 merged and issue #26 closed.
The owner also confirmed all three RLS files before PR #81 merged and issue #27 closed. The owner
confirmed seed application, verification, rerun and matching fingerprints before PR #82 merged
and issue #28 closed. CI remains offline with respect to Supabase; app-shell testing needs no SQL.
