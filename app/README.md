# CalBlue app

The future member app: accounts, identities, game registration, check-in and billing. The public
pages stay in the repository root. Issues #23–#24 provide the skeleton, rendering helpers, public
configuration contract and credential checks—not working sign-in or member features. The entry
page is still a placeholder and does not load `config.js` or connect to a backend. All frontend
files are public; Supabase Auth and row-level security must protect private data when those
features are implemented.

## The one rule

**No build step.** No `package.json`, no bundler, no transpiler, no package manager. This directory
is served exactly as it is committed. See [ADR 0001](../docs/design/adr/0001-client-stack.md) for the
reasoning and for the conditions under which we would revisit it.

Practically that means:

- Plain ES modules, imported by relative path with an explicit `.js` extension.
- The planned external dependency is Supabase **2.45.4**, loaded from
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm` in issue #29. Keep its version in
  one configuration constant and review upgrades; an exact version does not remove CDN risk.
- Use `textContent`/DOM methods or the `html` helper in `js/dom.js`, not ad-hoc `innerHTML`.
  Interpolate only text or values inside quoted ordinary attributes. The helper does not sanitize
  URLs, CSS or JavaScript. Validate dynamic URLs separately; never interpolate tag/attribute names,
  unquoted attributes, `on*` handlers, `style`, `srcdoc`, or script/style content. Attach handlers with
  `addEventListener`. Only code-owned markup may use `raw`.

## Running it

```bash
python3 -m http.server 8080 --bind 127.0.0.1     # from the repository root
```

Then open `http://localhost:8080/app/`.

There is no watch mode and nothing to compile. Edit a file, reload the page.

Do not store real secrets anywhere under this directory or the repository root: the preview
server can serve dotfiles such as `/.env`. `.gitignore` prevents accidental Git additions; it
does not provide HTTP access control. Keep server-side credentials in a secret store outside
the document root, including during local development.

## Current layout

```text
app/
  index.html        Placeholder entry point; no authentication yet
  config.js         Real public URL/publishable key; no client loads them yet
  js/
    dom.js          Escaping template helper
  tests/            Pure-logic suites and browser DOM checks
```

Issue #24 adds `config.js` and secret scanning. Issue #29 will add the client loader, router,
session state and `views/`; issue #30 implements authentication. Production app-origin
configuration remains separate from this local `/app/` preview; see DESIGN.md §2.

## Checks

```bash
python3 scripts/check_no_build.py
python3 scripts/check_secrets.py
python3 scripts/run_js_tests.py
python3 -m unittest discover -s tests -v
python3 scripts/check_site.py
```

Run these from the repository root. The JavaScript logic runner uses an existing Node executable
or macOS `osascript`; no package installation is needed. For the separate DOM tests, serve the
repository and open `http://localhost:8080/app/tests/`. Passing logic tests alone does not verify
browser parsing or module loading.

The secret scanner is also called by `scripts/check_site.py` and runs explicitly in CI before
the site is published. Its regression tests run in the normal Python suite; they can also be
run separately with `python3 scripts/test_check_secrets.py`. Test credentials are synthetic.

## Which key goes where

`config.js` holds the project URL and a **publishable browser key**. Both are public by design,
but access still depends on database grants and correct row-level-security policies. A public
key does not make an unprotected database safe. The export remains named `SUPABASE_ANON_KEY`
for compatibility with the queued app-client imports; it may hold a modern publishable key or
a legacy public anon key. Do not assume this value is a JWT or a signed-in user credential.

The **service-role key bypasses row-level security entirely**. It must never appear in this
directory, in any committed file, or in any deployed asset. It belongs only to server-side scheduled
jobs. `scripts/check_secrets.py` detects Supabase secret-key formats and non-placeholder
service-role assignments without printing credential values. It checks the Git index, tracked
working files and visible untracked/generated files. It does not scan Git history or ignored
private files, and it is not a substitute for RLS, access review or credential rotation.

| Value | Location | May be committed or served? |
|---|---|---|
| Project URL and public publishable/anon key | `app/config.js` | Yes; database permissions still need review. |
| Service-role/secret key | Future server-side job runner secret store | No. Never put it in this repository or a web document root. |
| Template names and placeholders | `.env.example` | Yes; no real private values. This file is documentation and is not loaded by the browser. |

If a real secret is exposed, revoke/rotate it first and assess the exposure. Removing the current
file does not remove copies in Git history, deployed artifacts or logs. Coordinate any history
cleanup with the maintainers; do not force-push a shared branch as an automatic remediation.

## Project setup — configured and confirmed

The user-provided project `https://rmksoklavpoartewjvus.supabase.co` and its publishable key are
recorded in `app/config.js`. A read-only request to `/auth/v1/settings` using that key succeeded
on **2026-09-16** and reported:

- Email provider enabled (`external.email = true`).
- New signups enabled (`disable_signup = false`).
- Email confirmation required (`mailer_autoconfirm = false`).

This verifies public endpoint/key acceptance and those reported settings, not email delivery,
an end-to-end magic-link round trip, database migrations or RLS. Site URL, redirect allow-list,
SMTP and organization ownership are not exposed by this endpoint. On **2026-09-16**, the user
confirmed the dashboard Site URL and exact redirect allow-list documented below. That completes
the configuration work for issue #24; the app page itself remains a placeholder and does not
initialize a client yet.

For administrator review or a future project replacement:

1. Select or create a **club-owned Supabase project**. Confirm ownership, region and any billing
   choices in the dashboard. No project is created by this repository or its CI.
2. Record the project URL and **public publishable or legacy anon key** in `app/config.js`.
   Keep the existing `SUPABASE_ANON_KEY` export name. Do not paste a service-role key, secret key
   or database password there. Run the secret checks before committing. The public config must
   contain only these two values at this stage; version/loader wiring follows in issue #29.
3. In Supabase Authentication settings, enable the Email provider and email confirmations;
   confirm email magic-link sign-in is available. End-to-end sign-in testing waits for issue #30.
4. Use the planned production Site URL **`https://app.calbluefc.com/`**, matching DESIGN.md §2.
   Add exact redirect allow-list entries for `https://app.calbluefc.com/`,
   `http://localhost:8080/app/` and `http://localhost:8091/app/` for these local previews.
   Avoid broad wildcard redirects. The production app origin is a plan, not a deployment made
   by this PR; do not launch private member features until it is correctly hosted and tested.
5. Do not expect database tables or policies yet. Migrations and RLS are separate issues
   #25–#28. Once those land, apply and verify them in order before storing real member data.
   Public keys never replace database permissions or RLS.
6. Keep any future scheduled-job service credential only in the job runner secret store.
   For local server-side jobs, use a protected credential file **outside all served directories**
   or the runner secret store. `.env.example` lists variable names only; no server-side job or
   credential loader is implemented here.

### Completion checklist for issue #24

- [x] Public config contract committed.
- [x] Key-handling documentation and secret checks with CI regression coverage.
- [x] User-provided project selected; public Auth endpoint is reachable.
- [x] Real project URL and public publishable key recorded in `app/config.js`.
- [x] Email provider, signup availability and email-confirmation requirement verified through public settings.
- [x] Site URL and exact redirect allow-list configured and confirmed by the user on 2026-09-16.

PR #78 can resolve issue #24 when merged. Actual client initialization is verified in issue #29,
and email delivery/callback testing in #30; this setup confirmation does not replace those tests.
