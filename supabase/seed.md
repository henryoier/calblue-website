# Disposable development seed

Issue #28 / PR #82 provides synthetic data for upcoming member/admin screens and demos.
It adds **data, not a migration or a new website screen**. Migrations 0001–0003 and their
authorization rules are unchanged. Nothing is applied to Supabase by CI or the coding agent.

**This seed commits persistent demo rows.** Unlike the earlier migration smoke tests, it does
not roll them back on success. Use only an **idle, disposable scratch project** with 0001–0003
already applied and no real users/data. Do not seed the configured production CalBlue project.

## Dataset

| Content | Initial state |
|---|---|
| Accounts and identities | 6 synthetic Auth/profile rows; 12 player identities, including a guest and a guardian-controlled child. |
| Roles | An admin/player, an ordinary player, a player/treasurer, a scoped-only competition organiser, a parent/coach and a pending player. |
| Organization | One CalBlue demo club, one default team and two fictional venues. |
| Schedule | One full upcoming pickup with 4 registered and 2 waitlisted, one demo competition with 3 published fixtures, and one completed historical pickup. |
| Registrations | 10 season roster rows and 29 match registrations, with pending review, attendance and cancellation cases. |
| Billing | Two fee schedules, one open billing period, three generated game-fee charges and one recorded payment. |
| Example balances | Ada has paid and owes 0; Ben owes 10; the unclaimed guest has a 10-unit charge without an account payer. |

All people/contact values are invented; account emails use `example.com`. Opponents and the cup
are labeled as demos, not real CalBlue competition results. No member photos or existing public
website data is imported. The synthetic Auth rows are database fixtures: **no passwords, usable
browser-login identities or email delivery are provisioned**. Real login testing belongs to the
authentication workflow, not this seed.

Dates are anchored to the first installation's Los Angeles calendar date. The historical pickup
is seven days before that date; the upcoming pickup is seven days after it. The billing quarter
is derived from the historical game, so seeding near a quarter/year boundary remains coherent.
Later reruns do not roll the schedule forward.

## Safety and rerun behavior

- Explicit opt-in is **off in the checked-in file**. The operator must confirm the intended
  disposable project and enable the one marked SQL line in their copied query.
- The seed requires the actual application-table owner and the installed core, billing and RLS
  objects. A service key or an admin JWT is not a substitute for the owner session.
- On first installation, all 17 application tables and `auth.users` must be empty. The seed takes
  transaction/table locks while checking and installing. No nonempty project is merged, repaired
  or truncated to make it fit the fixtures.
- The entire installation is one transaction. It creates the past game as completed, records
  attendance, and invokes the existing private finalization implementation to generate charges
  and lock the game. It does not fabricate automatic charges or bypass billing triggers.
- A versioned completion marker is written to the synthetic admin account's Auth application
  metadata **last**. A recognized marker makes the next run return before fixture writes. This
  avoids the old problem where `ON CONFLICT DO NOTHING` still fired BEFORE triggers or repeated
  profile updates changed roles/timestamps/audit history.
- Reruns preserve dates and subsequent demo edits; they are **not resets**. A malformed marker or
  unexpected version fails closed. No password, policy, trigger or privilege is weakened.

The empty-data and opt-in guards cannot identify which Supabase project you intended. Check the
dashboard project name yourself. Keep the scratch project idle: concurrent Auth/owner activity can
cause lock waits or a deadlock rollback. Investigate an error before retrying the complete file;
do not remove guards or attempt a partial repair.

## Manual verification reference — completed by the owner for PR #82

The owner reported all four steps passed, including matching fingerprints, before PR #82 merged
and issue #28 closed. This is owner-reported verification, not database execution by the coding
agent. The instructions and blank result template below remain for a fresh disposable project.
Do not repeat these SQL steps just to test the app shell in PR #83.

Use the **same empty disposable project where PR #81's three files succeeded**, if it is still
empty. In SQL Editor select `postgres` / database owner. **Do not rerun any migration.**

1. Copy the complete [seed.sql](seed.sql) into a new query. Near the top, enable the marked opt-in
   line by removing its leading `--`:

   ```sql
   SET LOCAL calblue.seed_confirmation = 'disposable-demo-only';
   ```

   Leave the initial empty confirmation assignment and all guards intact. Run the entire query
   with no partial selection. Expected: no SQL errors; the demo rows are committed. If the opt-in
   line is still commented, the confirmation guard should reject the run without installing data.
2. Run the complete [tests/seed_verify.sql](tests/seed_verify.sql) in another new query. Expected:
   no SQL errors. Save the returned **`dataset_fingerprint`** value.
3. Rerun the **same opted-in seed query** from step 1. Expected: no SQL errors; the completion
   marker selects the no-write path rather than inserting duplicates or rewriting demo rows.
4. Run `seed_verify.sql` again. All assertions should pass and the second `dataset_fingerprint`
   must **exactly match** the first. There must be no other edits/clients between these checks.

The verification is read-only. It checks initial fixture counts and relationships, guardian and
scoped-role cases, balances and representative RLS reads. Its comparison checksum includes all
18 Auth/application tables plus audit sequence state, including timestamps and Auth metadata.
Matching row counts alone would miss unwanted updates; matching fingerprints checks those too.
The checksum is not a password or an authorization token.

Original-fixture assertions are intended for this initial verification, before exploring the demo.
After deliberately changing registrations/roles/fees, those assertions can legitimately fail;
rerunning the seed will not restore the original values. Use a new disposable project for a fresh
demo. This PR does not supply destructive cleanup/reset SQL.

Do not rerun the earlier empty-project migration smoke tests after seeding: they intentionally
reject nonempty databases. Real browser authentication, email delivery and multi-session races
remain unverified by these checks. Owner-set synthetic claims in the verification are not real
signed browser sessions.

Stop on any SQL error or fingerprint mismatch. Share the file and exact error, excluding private
information. Do not delete real users/data, drop tables or loosen permissions to continue.

```text
Tested PR commit: <full commit SHA>
Environment: idle disposable project with 0001–0003 already applied
First opted-in seed.sql run: not run
First seed_verify.sql run: not run
First dataset_fingerprint: <value>
Second opted-in seed.sql run: not run
Second seed_verify.sql run: not run
Second dataset_fingerprint: <value>
Fingerprints identical: not checked
SQL errors: <none, or exact text excluding private information>
```

## Offline checks

```bash
python3 scripts/check_seed.py
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 -m unittest discover -s tests -v
```

These inspect documented SQL structure, fixture coverage and safety conventions. They do not
execute PostgreSQL, prove rerun behavior or certify production safety. Owner-reported scratch
verification is recorded in merged PR #82; issue #28 is closed.
