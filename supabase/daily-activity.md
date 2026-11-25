# Daily Supabase activity check

The **Supabase daily activity** GitHub Actions workflow sends one small read-only
database request to each project every day. This is best-effort activity and an
availability check, **not a guarantee against Supabase's free-plan pausing**.
The inactivity notices identify Pro as the supported way to prevent automatic
inactivity pausing. This workflow makes no billing or plan changes.

## Targets and schedule

- `website`: CalBlue Website, `rmksoklavpoartewjvus`.
- `verification-test`: calblue-verification-test, `njsprzewuxmrfpgwktmf`.
- Daily at **16:23 UTC**: 09:23 Pacific during daylight saving time, 08:23 during
  standard time. GitHub may delay scheduled runs; this is not an exact-time SLA.
- The schedule becomes active only after the PR is merged into the repository's
  default branch and GitHub Actions is enabled. Opening or pushing a PR does not
  activate the schedule. No merge is performed by the implementation agent.
- After merge, **Actions → Supabase daily activity → Run workflow** runs the same
  check immediately. Forks are excluded by the job's repository guard.

GitHub can disable scheduled workflows after prolonged repository inactivity
(currently 60 days for public repositories). Check Actions if runs stop and
re-enable the workflow if needed. Failed-run notifications depend on each user's
GitHub notification settings; this does not install an independent alert service.
No scheduled runner can promise uninterrupted activity indefinitely.

## What each request does

The checked-in Python script sends an anonymous HTTPS **HEAD** request to:

```text
https://<approved-project-ref>.supabase.co/rest/v1/games?select=id&limit=1
```

This uses PostgREST to perform a small RLS-filtered database read, rather than
pinging the Auth health endpoint. Migration 0003 already grants anonymous reads
of the public game ID column and hides drafts. An empty eligible result is still
a successful check; no fixture or seed row needs to be created.

The request uses a publishable key, JSON Accept header and `Cache-Control: no-cache`.
It does not request an exact count. HEAD returns no game-row body. The script
reads the HTTP status and Content-Type but never reads response bodies or logs
response headers, row values, keys, URLs or raw exceptions.
Logs contain only the fixed project label and HTTP status or a safe
failure category. A success demonstrates that the read endpoint responded then;
it does not establish full Auth/member-app functionality or reset an inactivity
deadline we can verify.

No SQL migration, table/policy change, INSERT/UPDATE/DELETE, login email, account,
role grant, service credential, or admin session is involved. Existing member and
test data stay unchanged. The public static website does not depend on these
requests; Supabase serves the member app and scratch testing.

## Configuration and failure handling

Targets and **intentionally public publishable keys** are in
[.github/supabase-activity.json](../.github/supabase-activity.json). These are not
database passwords or privileged server credentials. Do not replace them with
service keys, secret keys, personal access tokens, or authenticated-user tokens.
The checker rejects credentials without the publishable-key format, unknown or
duplicate project refs, and malformed configuration before making any request.
Only the two explicitly approved project/label pairs are supported.

The checker verifies TLS, follows no redirects, uses no browser session/cookies,
and checks both projects even if the first fails. HTTP connections use a
20-second socket timeout. A transient network error or HTTP 408/429/5xx gets at most one retry
after a short delay; authorization/configuration failures are not retried.
The entire workflow job is capped at five minutes.

HTTP 200 or 206 with an application/json response type is accepted. Any failed
project makes the job fail rather than recording a successful keep-alive. If a
key is rotated, update that project's publishable key in the config through a
reviewed PR. A project replacement requires explicitly updating the approved
targets and tests; do not silently substitute another database.

If a project has already paused, this check cannot unpause it. Inspect its
Supabase dashboard and use the owner's restore controls where available. Do not
disable RLS, add grants, seed data, or reset/delete the project to make a check pass.
Local networking restrictions must also be respected; do not disable TLS or
local security controls to force a successful test.

## Testing and operation

```bash
# Offline unit/contract tests; mocked transport only.
python3 -B -m unittest tests.test_supabase_activity tests.test_supabase_activity_workflow

# Live, read-only requests to both approved projects (no data writes).
python3 -B scripts/check_supabase_activity.py
```

Expected successful log lines are labelled `website` and `verification-test`,
each with HTTP 200 (or 206). Exit status is zero only when both pass.
The ordinary PR foundation workflow runs the offline tests; it does not generate
Supabase traffic. Live traffic comes from the explicit checker invocation, daily
schedule, or manual workflow dispatch after merge.

To stop recurring traffic, disable **Supabase daily activity** in GitHub Actions
or remove its schedule in a reviewed change. No project data cleanup is needed.
