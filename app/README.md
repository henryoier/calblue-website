# CalBlue app

The authenticated part of the site: member accounts, identities, game registration, check-in and
billing. The public marketing pages stay in the repository root; everything private lives here.

## The one rule

**No build step.** No `package.json`, no bundler, no transpiler, no package manager. This directory
is served exactly as it is committed. See [ADR 0001](../docs/design/adr/0001-client-stack.md) for the
reasoning and for the conditions under which we would revisit it.

Practically that means:

- Plain ES modules, imported by relative path with an explicit `.js` extension.
- One pinned external dependency — the Supabase client — imported from a CDN in `js/supabase.js`.
  Upgrading it is a one-line change in one file.
- Views build DOM through the escaping `html` helper in `js/dom.js`. Do not assign `innerHTML`
  directly; that is how an escaping bug becomes an XSS bug.

## Running it

```bash
python3 -m http.server 8080     # from the repository root
```

Then open `http://localhost:8080/app/`.

There is no watch mode and nothing to compile. Edit a file, reload the page.

The shell uses hash routes, so URLs such as `/app/#/games` work without
server rewrites. Routes for later member and admin screens render honest
placeholders until their numbered issues land; every link currently shown in
the role-aware navigation resolves to one of those routes.

Async route views receive a third context argument with an `AbortSignal` and
an `isCurrent()` check. Fetch with that signal and confirm the route is still
current before mounting delayed results, so an old request cannot overwrite a
newer screen.

## Layout

```text
app/
  index.html        Single entry point; the hash router renders into it
  config.js         Supabase project URL and anon key (public, safe to commit)
  js/
    supabase.js     Client singleton, pinned version
    router.js       Hash routing
    session.js      Signed-in state and roles
    dom.js          Escaping template helper
  views/            One module per screen
```

Authorization labels in the UI come from `user.app_metadata.roles` in the
current JWT, matching the claims evaluated by RLS. Profile rows provide display
details only. After an administrator changes a role, refresh the access token
before expecting either the UI or database permissions to change.

## Keys

`config.js` holds the project URL and the **anon key**. Both are public by design: the anon key is
the identity that row-level security evaluates against, and it grants nothing on its own.

The **service-role key bypasses row-level security entirely**. It must never appear in this
directory, in any committed file, or in any deployed asset. It belongs only to server-side scheduled
jobs. `scripts/check_secrets.py` fails the build if one shows up in tracked files.

The committed config contains placeholders until a club administrator provisions the project. To
finish that one-time setup:

1. Create the Supabase project in the club-owned account and apply the migrations in
   `supabase/migrations/` in filename order.
2. In **Authentication → Providers → Email**, enable magic-link sign-in and email confirmations.
3. Set the production site URL to `https://calbluefc.com/app/` and allow redirects to both
   `https://calbluefc.com/app/` and `http://localhost:8080/app/`.
4. Copy the project's URL and browser-safe anon/publishable key into `app/config.js`.
5. Put the service-role key only in the scheduled job runner's secret store. For local job work,
   copy `.env.example` to an ignored `.env` file and fill it there.

Run both the scanner and its unit tests before pushing configuration changes:

```bash
python3 scripts/check_secrets.py
python3 scripts/test_check_secrets.py
```

Run the app-shell checks with:

```bash
python3 scripts/check_site.py
python3 scripts/run_js_tests.py
```

The first command verifies the module graph and that every internal navigation
link has a registered route. The second runs the router, role matrix, session,
configuration, and escaping logic under JavaScriptCore. Open `/app/tests/` in
a browser for the DOM-dependent checks.
