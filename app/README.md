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

## Keys

`config.js` holds the project URL and the **anon key**. Both are public by design: the anon key is
the identity that row-level security evaluates against, and it grants nothing on its own.

The **service-role key bypasses row-level security entirely**. It must never appear in this
directory, in any committed file, or in any deployed asset. It belongs only to server-side scheduled
jobs. `scripts/check_secrets.py` fails the build if one shows up in tracked files.
