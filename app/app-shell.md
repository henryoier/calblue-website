# App shell — issue #29 / PR #83

This is the historical review guide for PR #83. For current functionality and testing, use
[README](README.md), [Sign in](sign-in.md), and [My identity](identity.md). Sign-in and identity
are no longer placeholders; the descriptions below record the shell's original scope.

This PR replaces the old “shell lands in issue #29” entry page with a working navigation and
session shell. It does **not** implement member workflows or require any Supabase SQL changes.
Migrations 0001–0003, the verified seed, public league/gallery data and the configured public
Supabase URL/key are unchanged.

## Implemented

- One static `/app/` entry point with hash routes, back/forward navigation, route titles,
  parameter/query parsing and a real 404 for unknown or malformed routes. No server rewrites.
- CalBlue header, role-aware navigation, footer, skip link and consistent loading, error,
  access-denied and placeholder views. Route changes manage focus and cancel/dispose old work.
- A single pinned Supabase client, existing-session restoration, access-token role handling,
  own-profile display state, deferred Auth-event synchronization and per-device sign-out.
- Stale profile/session requests cannot restore an old identity. Profile or connection failures
  show a retryable warning without hiding public routes or granting extra access.
- Mobile typography and wrapping at 360px using the public design variables, accessible focus
  outlines, 44px navigation controls and reduced-motion support.
- Offline logic/lifecycle checks and a browser test page using injected session/SDK doubles.

## Not implemented

Magic-link sign-in (#30), onboarding, identity editing, live app schedules, registration,
check-in, payment recording and audit screens remain separate issues. The sign-in page has no
email form and sends no email. Other future screens explicitly say they are placeholders.
The public website's existing schedules/gallery are not replaced by these placeholders.

The seed's Auth rows have no usable browser-login credentials. Do not invent passwords, edit
Auth metadata or grant yourself roles just to test this shell. Use the browser test doubles for
the role matrix; real Auth/email callback verification belongs to #30.

The SDK uses PKCE settings but **does not detect or exchange callback URLs yet**. Loading the
app restores an existing session only. Production hosting at `app.calbluefc.com` and verification
of the actual production policies remain prerequisites before live private member workflows.
All frontend assets and public configuration are public; hidden navigation is not authorization.

## Routes and current access

| Hash route | Access | Expected view |
|---|---|---|
| `#/` | Everyone | Members home and an honest feature-status explanation. |
| `#/games` | Everyone | Games placeholder for #34, not a live schedule. |
| `#/sign-in` | Everyone | Sign-in placeholder for #30; an existing session is acknowledged. |
| `#/identity` | Any signed-in account, including no club-wide roles | Identity placeholder for #31. |
| `#/sign-out` | Signed-in account | Sign out on this device; report success only when confirmed. |
| `#/admin/verify` | `admin` | Verification placeholder for #32. |
| `#/admin/payments` | `admin` | Payments placeholder for #44. |
| `#/admin/audit` | `admin` | Audit placeholder for #51. |
| `#/admin/clubs` | `admin` | Clubs/teams placeholder for #52. |
| Unknown/malformed route | Everyone | Page not found; never a blank page. |

The exact role names come from the current access token, not newer mutable user metadata or
profile fields. JWT decoding is not signature verification. Supabase verifies tokens and RLS
enforces access. Current migration 0003 keeps club-wide payments/audit administration admin-only;
`treasurer`, `developer`, `coach` and scoped organiser grants do not imply global admin access.

## Run locally

From this PR's checkout, start a loopback-only static server on an unused port:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://localhost:8080/app/`. If another preview already uses that port, choose a free one;
do not stop an unrelated server. Use the same port in all test URLs. No Node, package installs,
database password, migration rerun or seed rerun is needed.

Keep secrets outside the served directory. Python's static server can serve dotfiles; Git ignore
rules are not HTTP access control. The configured publishable key is intentionally public.

## Owner browser checklist — pending

1. Open `/app/`. Confirm the CalBlue header/nav/footer and **Members home** replace the old #29
   placeholder. A signed-out browser sees Home, Games and Sign in, not admin links.
2. Open `#/games` and `#/sign-in`. Each should clearly name its future issue. The absence of a
   game list or email form is expected, not a failed implementation.
3. While signed out, open `#/identity` and each `#/admin/...` route directly. Expect **Sign in
   required**, not a private screen. Open `#/does-not-exist` and `#/%ZZ`: expect **Page not found**.
4. Navigate Home → Games → Sign in, then browser Back/Forward. Check the view/title and active
   navigation stay correct. Tab to **Skip to content** and activate it: focus moves to content
   without changing the route. Keyboard focus should remain visible on links/buttons.
5. Set the actual browser viewport to **360px wide**. Repeat the route checks and confirm no
   horizontal page scrolling, overlapping headings or clipped controls. Also check desktop width.
6. Open `/app/tests/`. Expect a green summary and a **PASS** page title, with no failed cases.
   This includes a real 360px iframe, role/nav changes, stale-session handling, route cleanup,
   loading/error states, retry, sign-out and escaping. These cases use local test doubles;
   they neither log into Supabase nor send emails or write database rows.
7. Optional connection-error check: in browser request blocking, block the pinned
   `cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm` request and reload `/app/`.
   Expect a connection warning plus usable public routes. Unblock it, then click **Retry
   connection**. Clear the block afterwards. Do not edit the committed URL/key for this test.

If you have a previously authenticated browser, the shell may restore that real session and
perform its own-profile read. Real login/refresh across tabs and devices is separate from the
injected tests. Do not share tokens, private profile data or browser-storage contents when reporting.

```text
Tested PR commit: <full SHA>
Browser and version: <value>
Signed-out route/404 checks: not run
Back/forward, titles, focus and skip link: not run
Actual 360px viewport and desktop: not run
/app/tests/ summary: not run
Optional blocked-CDN/retry: not run
Real Auth/email callback: deferred to #30
Errors: <none or exact error without private data>
```

## Automated evidence and limits

```bash
python3 scripts/run_js_tests.py
osascript -l JavaScript scripts/run_session_tests.jxa.js
python3 -m unittest discover -s tests -v
python3 scripts/check_no_build.py
python3 scripts/check_secrets.py
python3 scripts/check_site.py
python3 scripts/build_migrations.py --check
python3 scripts/check_sql.py
python3 scripts/check_seed.py
```

The logic runner uses the existing JavaScriptCore on this Mac (or existing Node on CI), with no
packages. The separate macOS async diagnostic runs the exact DOM-free session/provider tests
with native Promises and a controlled timer queue; it is not a browser. Local module-reference
checks do not validate JavaScript exports, native module loading or remote CDN behavior.

The coding environment could not start an isolated Chrome instance because macOS denied app
startup. Therefore **native browser/DOM, visual and actual 360px results remain unverified**
until the checklist above is completed. Successful HTTP/MIME, logic, lifecycle and Python checks
are not substitutes. No SQL, real Auth login, email delivery or production deployment was performed.
