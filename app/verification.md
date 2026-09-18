# Player verification — issue #32

`#/admin/verify` replaces the verification placeholder. Only a signed-in account with the
`admin` claim can use it. Database RPCs independently refuse non-admin callers; hiding the
navigation is not the security boundary.

## What is implemented

- A pending queue ordered by creation time, newest first, with 50 identities per page.
- Submitted name search across **all statuses**, matching display or legal name as a literal
  case-insensitive substring. Blank search returns to the pending queue. Search text stays in
  memory, not the URL or browser storage.
- Review and confirm an individual approval or rejection. A rejection needs a reason; an
  approval can include an optional note. Notes are visible to the member and their guardian,
  so administrators must not use them for confidential internal remarks.
- Select pending identities on the current page and review a bulk approval. The confirmation
  lists the selected people and applies one shared note. Changing the page/search or reloading
  clears selection; this is not a hidden selection of the entire database.
- Database-stamped `decided_by` and `decided_at`, rather than client-provided audit claims.
- Read-only status and decision notes for completed reviews in search results. Reopening a
  completed decision is not part of this screen.
- A member or guardian can open **My identity → Open / edit** to see the decision note.
  Notes are read-only there and excluded from initial identity summaries and public roster data.

Approving an identity does **not** grant an account role, approve competition registration,
publish the static website's player directory, or register anyone for a game. For an identity
already opted into the public roster, verification makes its existing limited public projection
available. The screen does not provide DOB correction, roster import or account-role management.

## Database deployment is a separate owner action

This feature adds [migration 0004](../supabase/migrations/0004_player_verification.sql).
Read the [migration and SQL verification guide](../supabase/0004-player-verification.md) before
applying it. Migrations 0001–0003 are unchanged and must **not** be rerun. No seed is needed.
Neither the coding agent nor CI applies SQL, creates accounts or grants administrator roles.

The configured project already contains real account/identity data. Do not run disposable seed
or synthetic fixture scripts there. Prefer a separate approved scratch project for database
tests. If no approved administrator exists, stop and arrange an exact-account owner-controlled
bootstrap separately; do not grant roles in browser metadata or to an arbitrary account.
After a legitimate role change, use **Refresh my access** to obtain a new JWT.

Before 0004 is applied, the new RPCs are unavailable and the screen will show a load error.
The existing personal identity workflow continues to use fields that existed before 0004.

## Safety and concurrency

The queue retrieves only names, IDs, status/decision notes, creation/update times and decision
metadata. It does not retrieve medical notes, emergency contacts, DOB, login email or account
ownership IDs. The established broader administrator table permissions are not expanded.

Decisions apply only to pending identities. Every selected ID carries the exact `updated_at`
value that was reviewed, including database sub-millisecond precision. The server takes the
existing billing lock before row locks and validates the whole batch. If a member edits a
selected identity or another administrator decides it first, **none of this batch is applied**:
reload and review the current records. Up to 50 decisions commit atomically.

A lost response is different from a refused decision. The server may already have committed
even if the browser reports an uncertain result. The UI blocks resubmission until a deliberate
reload/check; it never retries a write automatically or promises that navigation undoes it.

Same-account refreshes preserve a note draft only while admin access remains. Revocation,
sign-out, account switching and navigation abort requests and clear private UI state; late
responses cannot restore it. JWT-based role revocation has the same limitation as the released
RLS model: an already issued token can remain valid until refreshed/expired. The UI cannot
retroactively cancel a database action already accepted with a valid token.

Existing historical decisions receive no invented actor or date during migration. Null
decision metadata remains unknown history. New decisions are stamped by the database.
These fields record the latest decision, not a full audit trail of every player edit.

## Automated checks (no live service)

```sh
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 scripts/check_seed.py
python3 -m unittest discover -s tests -v
python3 scripts/run_js_tests.py
python3 scripts/run_async_js_tests.py
python3 scripts/check_site.py
```

Pure logic and asynchronous tests run with the existing JavaScript runtime, using RPC/session
doubles. They cover request/response allowlists, pagination, literal search, note validation,
optimistic version tokens, atomic-response expectations, write uncertainty and stale lifetimes.
Structural SQL tests inspect source, grants and guard patterns; they do **not** execute Postgres.

Open `/app/tests/` separately for native browser modules, DOM escaping and UI lifecycle tests.
Those also use doubles, not real accounts. A passing command-line suite is not a browser or
database authorization result.

## Owner review checklist

Coordinate switching the existing preview to this PR first. Do not stop someone else's server.
The normal URL is `http://localhost:8091/app/#/admin/verify`; callback origins are unchanged.

1. **Browser suite:** open `http://localhost:8091/app/tests/` and expect PASS. No Supabase setup
   or administrator role is needed for these injected tests.
2. **Database checks:** follow the 0004 guide in an approved scratch project. Confirm non-admin
   RPC refusal, direct member-update refusal, trusted metadata stamping and whole-batch conflict
   behavior. Record SQL results separately from mock results.
3. **Route access:** signed out, expect the sign-in guard. Signed in as an ordinary member,
   enter `#/admin/verify` directly: expect access denied and no private results.
4. **Queue/search:** with an approved administrator and migration installed, confirm newest-first
   pending entries; search a known display/legal name and find pending and completed identities.
   Empty search returns to pending. Check next/previous pages if more than 50 approved test
   identities exist; do not import dozens of fake people into the real project just for this test.
5. **Individual decisions:** use approved test identities only. Open approval review, cancel once
   and confirm no change. Then approve with an optional note. Reject another pending identity
   with a reason; blank reasons must not submit. Reload/search to confirm status and metadata.
6. **Member visibility:** as that person or their guardian, open their private identity details
   and confirm the rejection reason appears as text and cannot be edited. It must not appear
   in the initial summary list or public roster projection.
7. **Bulk approval:** select two approved pending test identities. Confirm the review lists exactly
   those two, cancel without changes, then reopen and confirm. Both should become verified.
   Search/page changes must clear selection; decided identities cannot be selected again.
8. **Conflict:** in two administrator tabs, review the same pending test identity. Decide in one;
   the stale tab must report a conflict, not overwrite it. In a batch containing that stale record,
   other pending records must remain unchanged. Reload before selecting again.
9. **Draft/lifecycle:** type an unsaved decision note, use **Refresh my access** with the same admin,
   and confirm the draft remains. Sign out/switch accounts: the private draft disappears. An
   owner-controlled role-revocation test is separate and must not be improvised on real accounts.
10. **Accessibility/recovery:** check keyboard operation, visible labels/focus, 360px layout,
    loading/errors and a disconnected read. If intentionally testing a write with a lost response,
    reload and verify the actual record before any retry; never assume rollback.

Do not report the scratch/live/browser checks as passed until the owner actually runs them.
Keep names, notes, account identifiers, tokens and callback links out of screenshots/log reports.
