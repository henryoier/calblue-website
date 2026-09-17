# Email sign-in — issue #30

This PR adds email magic-link sign-in to the member app. It does not change public-site navigation,
deploy a new app subdomain, edit Supabase settings, or run/change database migrations or seed data.
Identity editing remains issue #31; schedules, registration, check-in and billing remain placeholders.

## What is implemented

- An accessible email form at `#/sign-in`, with sending, generic success, retry and error states.
  Only submitting the form sends a request; viewing the page never sends email.
- PKCE callback handling before session/profile initialization. A protected route such as
  `#/identity` returns to that route after sign-in rather than always going home.
- Supabase-managed session persistence and automatic token refresh. Reloading the same origin
  restores the login and reloads the signed-in account's own profile.
- Blank `display_name` is valid: the app uses the account email and explains that editing comes later.
  The existing database trigger creates the profile; the browser does not insert rows or assign roles.
- **Refresh my access**, visible while signed in, refreshes the JWT and reevaluates navigation and
  the current route. Role changes are not immediate until token refresh. RLS remains authoritative;
  hiding a navigation item is not authorization.
- **Sign out** clears this device's session and cached account/profile state after confirmation.
  It does not revoke other devices' sessions. A failed sign-out never claims success.

## Important behavior

Open the email link in the **same browser, browser profile and device** that requested it. The
browser stores the PKCE verifier. Another browser cannot finish that exchange: request a new link
there and open the new link there. A new request replaces the verifier; use only the latest link.
Links are one-time and their expiration is controlled by Supabase. Inbox security scanners can
consume links; request a replacement if needed. Avoid repeatedly requesting emails while waiting.

The app stores only a validated destination and timestamps alongside the SDK's own Auth storage;
it does not store the requested email or callback code in its destination record. The destination
expires after 60 minutes and must match an existing non-auth route. Unknown routes, query strings,
external URLs and sign-out destinations fall back to members home. Storage must work for reliable
PKCE across reloads/tabs. A one-minute resend cooldown is a UX safeguard, not an anti-abuse boundary;
Supabase still controls server-side email limits. Use one active sign-in request at a time.

Callbacks are removed from the address bar before SDK creation. This is important for the pinned
`supabase-js@2.45.4` / `auth-js@2.65.0`: PKCE initialization can automatically exchange a code even
when `detectSessionInUrl` is false. The app owns one explicit exchange and does not accept implicit
access-token/refresh-token fragments. Provider error descriptions are not rendered or logged. A
`no-referrer` policy avoids forwarding callback URLs through app resource/navigation referrers.
The initial callback request still reaches the static host; host logging policies are separate.

## Before testing real email

Use your own dedicated test account and an owner-approved project with the existing schema/RLS.
Synthetic demo seed users are not real email-login accounts. Do not seed or reapply migrations to
test this feature. No email delivery or Auth dashboard changes are performed by the offline tests.

From this PR's worktree, serve the repository with the existing Python runtime:

```sh
python3 -m http.server 8091 --bind 127.0.0.1
```

Use `http://localhost:8091/app/`, not `127.0.0.1`, a worktree file URL or an arbitrary port.
The exact owner-confirmed callback allow-list is:

- `http://localhost:8080/app/`
- `http://localhost:8091/app/`
- `https://app.calbluefc.com/` (planned hosting, not provisioned by this PR)

The request uses the exact root callback URL, without return-route query/hash parameters. The
intended route stays in browser storage. If another preview already occupies the chosen port,
do not terminate an unrelated process: stop the known preview or coordinate switching it first.
The public site's `/app/` URL is not automatically an approved email callback origin.

## Owner acceptance tests

### 1. Cold sign-in, intended route and profile

1. Start signed out in a fresh normal browser profile with storage enabled. Open
   `http://localhost:8091/app/#/identity`.
2. Click **Go to sign in**. Enter an email account you control and click **Send sign-in link**.
   There should be one request, then a generic inbox/spam notice, without revealing account existence.
3. Open the latest email link in this same browser/profile/device. It should finish at **My identity**
   (still an issue #31 placeholder), not always at home. Callback credentials must disappear from
   the address bar. A new account with a blank display name must not crash or show `undefined`.
4. Visit Members home and reload. You should still be signed in, with your own email/name.

### 2. Sign-out and bad-link recovery

1. Click **Sign out**. Confirm the success notice, signed-out header, hidden private navigation and
   no old email/name/profile left on the page. Reload: still signed out.
2. Reopen the already-used email link. It must show a readable recovery message and email form,
   without a blank page, exposed token or permanent spinner.
3. Wait at least one minute before requesting a replacement. Test a new link in a different browser:
   it should explain the failure; requesting a new link in that browser provides a recovery path.
4. Also test a genuinely expired link if practical. The exact expiration is a project setting,
   not a timer introduced by this PR. An email that never arrives is an SMTP/rate-limit/dashboard
   investigation, not proof that the callback code is broken.

### 3. Refresh a changed role (owner-controlled scratch project/account only)

1. With a dedicated account that has `admin` access, open a protected admin placeholder.
2. Using the project's authorized administration path, remove that account's `admin` role. Do not
   change a real member's role or remove your only administrator just to run a test.
3. Click **Refresh my access**. Admin navigation should disappear and the currently open protected
   route should say **You do not have access**. Restore the test role if needed and refresh again.
4. With a signed-in account, temporarily disconnect the network and try refreshing. A failure must
   be actionable, must not claim success, and must not restore another account's cached details.

## Offline and browser checks

```sh
python3 scripts/run_js_tests.py
python3 scripts/run_async_js_tests.py
osascript -l JavaScript scripts/run_session_tests.jxa.js
python3 -m unittest discover -s tests -q
python3 scripts/check_site.py
python3 scripts/check_no_build.py
python3 scripts/check_secrets.py
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 scripts/check_seed.py
```

Open `/app/tests/` and expect a **PASS** page title with no failures. Browser tests use injected
Auth/session doubles: no real emails, SDK/CDN requests or profile/database queries. Also inspect
the sign-in form at 360px width, keyboard focus, Enter submission and error announcements.
JavaScriptCore checks run logic and deterministic async doubles, not browser DOM parsing or
native module loading. Passing these checks does not certify SMTP, production RLS, app hosting
or a real login. Record those manual results separately before merging.
