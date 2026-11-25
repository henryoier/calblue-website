# Accounts and private billing

This extends the existing Supabase member app. It does not upload, decrypt or sync
the separate local club-office vault. The online database is the source of truth
for these screens. Review and migrate legacy records separately before relying on
online balances; do not infer ownership solely from a matching player name.

## Access and screens

| Visitor / account | Access |
| --- | --- |
| Signed out | Public pages and sign-in only; no private profiles or finance reads |
| Signed in, any member role | Own identity and guardian-managed identities; own historical payer account statement at `#/billing` |
| `admin` in the current signed access token | All member accounts, balances and linked player details at `#/admin/payments`; create charges and record reviewed Zelle receipts |
| Coach, player, treasurer or developer without `admin` | No club-wide financial or personal-data access |

No email address is hardcoded as an authorization bypass. Email/Google authenticate
identity; protected `profiles.roles` and signed `app_metadata.roles` determine
permissions. The released 0003 RLS policies and security-invoker account views
enforce data access at the database, including requests outside the UI. Member
queries also explicitly constrain `account_id`, and responses for a different
account are rejected. Guarded billing views clear on sign-out/account change or
loss of the current admin role. Pending responses cannot restore stale content.

An existing JWT may retain an old role until token refresh/expiry. Use **Refresh
my access** or sign out/in after a role change. This implementation does not claim
instant server-side revocation of already issued JWTs. Project owners must follow
their session revocation process when removing access urgently.

## Email and Google

The existing project public Auth settings were checked on 2026-10-21: email
sign-in enabled, Google disabled, and email confirmation required. The existing
email magic-link implementation is preserved. The new Google flow uses the same
PKCE callback scrubber, local pending-state TTL and allowlisted return paths.
It requests only OpenID/email/profile scopes, not access to Gmail or Drive.
The response URL must point to the configured Supabase authorization endpoint.

Google remains disabled in `app/config.js` until the project owner configures it:

1. Use an existing club-owned Google Cloud project or create one with the owner.
2. Configure OAuth branding/audience and the basic OpenID/email/profile scopes.
3. Create a Web application OAuth client. Add the production app origin and
   only needed local development origins. Use the callback URI shown in the
   Supabase provider settings (`https://rmksoklavpoartewjvus.supabase.co/auth/v1/callback`).
4. Save the OAuth Client ID and Client Secret in **Supabase Authentication →
   Sign In / Providers → Google**. Never put the client secret in repository files,
   browser config, screenshots, email or chat.
5. Verify the exact app redirect URLs and Site URL. Existing allowed app URLs:
   `https://app.calbluefc.com/`, `http://localhost:8080/app/`,
   `http://localhost:8091/app/`.
6. After provider setup, set `GOOGLE_AUTH_ENABLED = true`, deploy and complete
   a real owner-coordinated sign-in test. Verify the same intended account and role.

A working button or mocked callback test is not proof of a live Google setup.
Email delivery and real Google account linking remain deployment acceptance checks.

## Administrator bootstrap

A project owner must grant `admin` in the database to the specific verified Auth
account authorized by the club. Do not grant based on editable user metadata,
frontend email comparisons, signup order or every newly registered user. The
owner-run bootstrap file is delivered separately under `outputs/account-setup`
so the designated personal email is not embedded into published frontend assets.
It verifies an existing confirmed Auth email and matching profile, preserves other
roles, updates the role through the existing sync trigger, and rolls back on mismatch.
It has not been executed against the real project by this change.

## Money operations

- Account balances and ledger rows come from `v_account_balance` and
  `v_account_ledger`; the database computes all-time totals. Paginated UI lists do
  not masquerade as full-account totals. Financial ownership remains the payer
  recorded at the time, not a subsequently reassigned guardian/player relationship.
- Admins may create positive season-dues charges for a linked player. Current
  payer ownership is checked immediately before the insert. Closed-period and
  immutable-ledger database triggers remain authoritative.
- Recording Zelle requires a reviewed receipt, date, amount and reference. This
  is a manual accounting action, not a bank API response or an actual transfer.
- Each submitted form freezes an operation UUID and payload. A retry after a
  lost response uses the same ID; duplicate-key responses are accepted only when
  the persisted row matches the original fields. Do not recreate a new form entry
  for an uncertain save before checking the statement. This does not deduplicate
  two independently created entries with the same external bank reference.
- Corrections, refunds, combined-payment allocation and legacy-data migration
  require further reviewed workflows; this UI does not silently rewrite immutable
  financial facts. No email is sent by these screens.

## Encryption and actual privacy boundaries

Supabase documents encryption at rest for hosted projects; HTTPS protects traffic.
Database RLS controls which signed-in account can read a record. This does **not**
make the database end-to-end encrypted: authorized administrators and privileged
project infrastructure can access data. The online charge amounts/descriptions are
ordinary database columns within managed encrypted storage, not separately
application-encrypted ciphertext. Do not represent Base64, hidden navigation or
RLS alone as encryption. Hosted storage protection/configuration must be verified
for the actual deployment; these code tests do not inspect disk encryption.

The offline `.cbvault` remains AES-GCM encrypted with a separate passphrase. It is
an optional private archive, separate from online account access. Signing in as an
admin does not bypass that passphrase. Public GitHub holds code and public config,
not a copy of private player records, invoices, exports or private encryption keys.

## Validation and deployment

No new database migrations are needed for the billing screens: they use released
0001–0003 tables, RLS and views. Do not rerun released migrations on production.
Existing player verification additionally uses 0004. Confirm installed metadata
and permissions with the owner before launching any private feature.

Run the existing app logic/async/browser suites and `node --test
tests/member-app/*.test.mjs`. Unit tests cover account scoping, foreign-response
rejection, stale sessions, confirmed-only receipt writes, immutable retries and
Google PKCE/redirect restrictions. Browser tests include role removal, stale
response suppression, member-only controls and disabled Google setup state.
These mocks do not replace owner-run real RLS isolation tests (two members plus
one admin), email delivery or live provider checks. Existing SQL smoke files under
`supabase/tests/0003_*` exercise anonymous/member/admin financial policies.

Start the allowlisted local preview with `python3 scripts/start_member_app.py`.
It serves only public program assets and rejects dotfiles, private data and scripts.

Sources: [Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[encrypted storage](https://supabase.com/docs/guides/database/extensions/pgsodium).
