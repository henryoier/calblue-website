# ADR 0001 — Client stack: plain ES modules, no build step

- **Status:** accepted
- **Date:** 2026-08-29
- **Issue:** #23
- **Supersedes:** nothing

## Context

`docs/design/DESIGN.md` proposes an authenticated app for club members and admins, sitting behind the
existing public site. That site is, deliberately, a dependency-free collection of static HTML, CSS and
vanilla JavaScript: no package manager, no bundler, no build. It deploys by publishing the directory
to GitHub Pages or Netlify.

Adding an authenticated app forces a decision. The default reflex is a framework — Vite plus React,
or SvelteKit — because that is what most web applications are built with. That reflex deserves to be
examined rather than followed, because it would change the character of this repository and the way
it is deployed and maintained.

Three facts bear on the decision:

1. The app is roughly a dozen screens, almost all of them forms and lists. Registering for a game,
   editing a profile, marking twenty people present. There is no complex client state machine, no
   real-time collaboration, no heavy interactive canvas.
2. Authorisation is enforced by Postgres row-level security, not by the client. The client is
   therefore a thin renderer over an API that refuses to return data it should not. A framework's
   main structural benefit — disciplining a large stateful client — buys less here than usual.
3. The club is volunteer-run. Whoever maintains this in two years is not going to audit a transitive
   dependency tree, and may not have a working toolchain at all.

## Decision

Build the app as **plain ES modules served statically, with no bundler, transpiler or package
manager.** The Supabase client is imported from a pinned CDN URL. The app lives in `/app/` and is
deployed by the same "publish the directory" step as the rest of the site.

## Consequences

**What this buys**

- The deploy story does not change. No CI build, no artefact, no `dist/`. The thing in the repository
  is the thing that is served, which makes "what is actually in production?" answerable by reading it.
- No supply chain. One pinned dependency loaded from a CDN with an integrity-checkable version, rather
  than several hundred transitive packages nobody will ever review.
- The public site and the app share one stylesheet and one visual language without a bridge between
  two systems.
- It can be developed on a machine with no node installed, which is the case for the machine this is
  currently being written on.

**What this costs, stated plainly**

- No TypeScript. Type errors that a compiler would catch will be caught by tests and by review, or
  not at all. This is the most expensive part of the trade.
- No JSX. Views build DOM with template literals and small helpers, which is more verbose and easier
  to get subtly wrong around escaping. The mitigation is a single audited `html` helper that escapes
  interpolations by default, rather than ad-hoc `innerHTML`.
- Hand-rolled reactivity. Re-render on state change, deliberately coarse. Fine at this size; would not
  be at ten times the size.
- No tree-shaking or code splitting. Irrelevant at this scale — the whole app is smaller than one
  photograph on the gallery page.

**What would make us revisit this**

Any one of the following should trigger a new ADR rather than an incremental workaround:

- The app exceeds roughly thirty screens, or acquires genuinely complex shared client state.
- We need a native app that shares code with the web client (`DESIGN.md` §12, Milestone 7).
- Hand-rolled rendering causes a security bug — an escaping mistake leading to XSS — rather than
  merely being tedious.
- Two or more contributors are working on the client simultaneously and the absence of types is
  measurably costing time.

## Alternatives considered

| Option | Why not |
|---|---|
| **Vite + React** | The conventional answer, and the strongest alternative. Rejected because it introduces a build step, a package manager and a `node_modules` tree for an app whose complexity does not warrant them, and because it splits the repo into "the static site" and "the app" with different toolchains. |
| **SvelteKit** | Same objection, plus it wants to own routing and deployment, which would change how the whole site is published. |
| **HTMX + server templates** | Attractive, but there is no server. The architecture is a static client talking directly to Supabase; adding a server to serve HTML fragments would be a larger change than adopting a bundler. |
| **Plain ES modules (chosen)** | Accepts real ergonomic costs in exchange for keeping the project's existing character, deploy story and zero-dependency posture. |

## Implementation notes

- Module imports use relative paths with explicit `.js` extensions, as browsers require.
- The Supabase client is pinned by exact version in one place, `app/js/supabase.js`, so upgrading is a
  one-line change with an obvious diff.
- No `package.json` anywhere in the repository. `scripts/check_no_build.py` enforces this, so the
  decision degrades loudly rather than silently if somebody reaches for `npm init`.
