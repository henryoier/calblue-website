# Pickup game management — issue #33

`#/manage/pickup` lets an administrator or explicitly authorized team organizer create and manage
pickup games. The public site's schedule is unchanged. Member game browsing/detail, registration,
waitlist interaction, check-in, attendance finalization and payments belong to later issues.

## What works

- Create a **draft**, edit its title/location, venue-local times, capacity, registration window,
  kit color and operational notes. A saved draft is not automatically published.
- Separately review and confirm **publication**, **registration closure**, or **cancellation**.
  Cancellation requires a reason, retains registrations and cannot generate attendance charges.
- List the caller's manageable pickups, newest-created first, twenty per page. Completed, locked
  and cancelled games are read-only here. This screen does not reopen games or delete them.
- Administrators can set a fee override, including zero; a blank override inherits the fee schedule.
  Organizers cannot submit a fee override, and editing another field preserves an existing one.
- Missing teams/venues do not require a seed: an admin can create a teamless pickup without a saved
  venue, using a location label and IANA timezone. Creating reusable teams/venues remains issue #52.

## Authorization decision

The existing schema required pickups to have no competition but only authorized organizers through
a competition. Migration **0005** fixes this narrow mismatch with the existing `role_grants` model:

- A grant with `role = 'organiser'` and a `team_id` belonging to an `is_us` club permits pickup
  management for **that team only**. No new role values or scope columns are added.
- Admins can manage pickups across the club, including teamless ones. Organizers must choose a
  team they are explicitly authorized to manage. A competition/game grant alone is insufficient.
- This does not expand `manages_game()`, reveal emergency contacts, authorize attendance/billing,
  or permit management of another team's games or competitions.
- The signed-in navigation entry is not an authorization grant. Database RPCs refuse non-admins
  without the required scope. Unauthorized accounts see a refusal, not an empty staff dataset.
- Pickup writes must use the checked RPCs, including for signed-in admins. A direct client update
  cannot bypass status transitions, scope checks or optimistic concurrency. Actual database-owner
  maintenance and existing trusted billing functions retain their privileged boundary.

The migration creates no grants or accounts. Role provisioning remains an explicit owner/admin
operation, outside this editor. A developer/coach/treasurer role alone is not sufficient.

## Time and data handling

Every datetime-local field uses the displayed IANA timezone. A saved venue supplies its authoritative
zone; without a saved venue the organizer chooses the zone. Times are sent as timezone-qualified
instants, and the existing database trigger derives `game_date`. The browser's timezone is not used
to guess an instant. Nonexistent or ambiguous daylight-saving times are rejected with guidance.
An unchanged existing time preserves its original instant and fractional precision.
Native date controls display millisecond precision; unedited values retain their original database
microseconds. If a saved venue's timezone changed, the editor shows the same instants in its current
zone and asks for review before saving. No venue/time change is saved automatically.
Closing/cancelling also runs the existing database date trigger: a known venue timezone update
may change the displayed zone/date without moving any stored instant. The confirmation explains
that change; an unexpected zone or changed instant is treated as an unconfirmed response.

Validation requires gather time at/before kick-off, end time after kick-off, and an ordered
registration window ending no later than kick-off. Capacity is a positive integer or unlimited;
it cannot be reduced below the occupied player/keeper count. Publishing requires a future start
and a valid, canonical saved form; legacy drafts needing normalization must be edited/saved first.

Operational notes on published games are already visible to authenticated members under the
existing policy. Cancellation reasons are game-visible. Neither is a confidential medical/contact
field; do not put personal secrets there. Text is rendered through the escaping helper, never HTML.

## Conflicts, recovery and lifecycle

Updates carry the exact reviewed `updated_at`, including microseconds. Database writes take the
existing billing lock before row locks and reject stale versions, illegal transitions, attendance
locks and games already linked to charges. Released migrations 0001–0004 are unchanged.

The editor blocks duplicate submissions. A lost/aborted/malformed write response is **unconfirmed**,
not reported as a failed or rolled-back save. Use **Reload games to check**, inspect the current
record, then decide whether another attempt is appropriate. Recovery starts on the newest page.
For new drafts, check the list before
creating another one. No write retries automatically. A confirmed save remains visibly confirmed
even if the following list reload fails.

Navigation, account change, role change and sign-out dispose old private UI and fence late results.
Unchanged same-account refreshes preserve the form. **Refresh my access** rechecks the database
options: changed access or venue settings clear the editor. Drafts are not persisted in browser
storage or URLs. Server checks remain authoritative; refreshing cannot revoke an operation the
database already accepted.

## Review and testing

Run the normal Python, pure-JavaScript and asynchronous-double suites. `/app/tests/` additionally
contains native-browser DOM and app lifecycle tests using injected services only—no real accounts,
emails or database writes. Offline tests are not proof of live SQL, browser layout or concurrency.

Use the [0005 guide](../supabase/0005-pickup-games.md) for the separate owner-run migration and SQL
smokes. Do not rerun older migrations/smokes or seed a project containing real member data. An
already configured project remains unchanged until its owner explicitly applies this migration.
The new smoke permits either empty scratch or a narrowly checked single-admin bootstrap-only
scratch state, preserving that existing login/profile/audit history. Other nonempty states are
refused; do not reset a project to force eligibility.

Focused browser checks after an authorized 0005 installation:

1. In an approved scratch environment, create one clearly labeled draft; confirm it stays draft
   and its venue-local gather/kick-off times survive reopening. No repeat of identity/account setup
   is required. Try gather after kick-off: the form must block it without a write.
2. Review publication, go back once, then confirm. Close registration separately. Check each saved
   status after reload. Member/public list UI is not claimed in this PR; SQL tests check visibility.
3. Cancel with a nonblank reason, first cancelling the confirmation once. Confirm the saved reason
   renders as text and the game becomes read-only. Existing registrations must remain unchanged.
4. With an already approved team-organizer fixture, check own-team access and fee restrictions;
   another team/member/competition-only organizer must be refused. Do not create accounts or grant
   roles solely for this test without explicit approval. Record skipped cases as not tested.
5. Optional deeper manual checks: stale versions in two tabs, unknown-response recovery, access
   changes and same-account draft refresh, keyboard focus/labels and 360px layout. Actual overlapping
   database sessions are a separate concurrency test; two sequential tabs do not establish it.

Record the tested commit and distinguish automated doubles, owner-run SQL, real browser passes,
skips and unconfirmed coverage. Do not include account IDs, credentials or private notes in PR logs.
