# CalBlue app

The future member app: accounts, identities, game registration, check-in and billing. The public
pages stay in the repository root. Issue #23 adds only this skeleton and rendering helpers, not
working sign-in or member features. All frontend files are public; Supabase Auth and row-level
security must protect private data when those features are implemented.

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
python3 -m http.server 8080     # from the repository root
```

Then open `http://localhost:8080/app/`.

There is no watch mode and nothing to compile. Edit a file, reload the page.

## Layout in this issue

```text
app/
  index.html        Placeholder entry point; no authentication yet
  js/
    dom.js          Escaping template helper
  tests/            Pure-logic suites and browser DOM checks
```

Issue #24 adds `config.js` and secret scanning. Issue #29 adds the client loader, router, session
state and `views/`. Production app-origin configuration remains separate from this local `/app/`
preview; see DESIGN.md §2.

## Checks

```bash
python3 scripts/check_no_build.py
python3 scripts/run_js_tests.py
python3 -m unittest discover -s tests -v
python3 scripts/check_site.py
```

Run these from the repository root. The JavaScript logic runner uses an existing Node executable
or macOS `osascript`; no package installation is needed. For the separate DOM tests, serve the
repository and open `http://localhost:8080/app/tests/`. Passing logic tests alone does not verify
browser parsing or module loading.

## Keys

The future `config.js` holds the project URL and the **anon key**. Both are public by design, but
access still depends on database grants and correct row-level-security policies. A public key
does not make an unprotected database safe.

The **service-role key bypasses row-level security entirely**. It must never appear in this
directory, in any committed file, or in any deployed asset. It belongs only to server-side scheduled
jobs. Issue #24 adds `scripts/check_secrets.py` to check tracked files for secret keys.
