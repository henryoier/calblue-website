# Working on this repo alongside other agents

Several coding agents build this repository at the same time — currently `cc` (Claude Code), `codex`
and `muse`. They cannot see each other and cannot coordinate in the moment, and git will happily let
two of them edit the same file in the same directory.

Two mechanisms keep them apart:

- **`scripts/agent_guard.py`** — the versioned enforcement layer, installed into the clone's shared
  hooks directory by `scripts/install_agent_guard.sh`. A per-worktree lease refuses commits
  and pushes from the wrong agent, the wrong branch, or an unclaimed worktree. It is local and not
  version-controlled, because it is machine state rather than project source.
- **`scripts/check_worktrees.py`** — the inventory. The guard only ever sees the worktree it was
  invoked from; this answers the question it cannot, which is whether the *machine as a whole* is
  in a sane state.

## The rules

| Thing | Rule |
|---|---|
| Working directory | `~/calblue-wt-<slug>-<agent>` — one per unit of work |
| Branch | `<type>/<slug>-<agent>` — always suffixed with your agent tag |
| Agent tags | `cc`, `codex`, `muse` |
| `~/calblue-website` | The shared reference clone. Stays on `main`, marked `calblue.readOnly`. **Nobody works in it.** |
| Base | `origin/main`, or an explicit parent PR branch. Never whatever `HEAD` happens to be. |
| Upstream | Your branch must track `origin/<your-branch>`, not `origin/main` |

Start work with the helper, which does all of it including the guard setup:

```sh
scripts/agent_worktree.sh cc migration-core
# -> ~/calblue-wt-migration-core-cc on feat/migration-core-cc, configured and claimed
```

For an existing clone, install or refresh the hooks once before claiming worktrees:

```sh
scripts/install_agent_guard.sh
```

Check the machine at any time:

```sh
python3 scripts/check_worktrees.py
```

## How the guard works

Each worktree carries its own git config and a claim file at `<git-dir>/agent-claim.json`:

| Setting | Meaning |
|---|---|
| `calblue.agent` | who owns this worktree; stored with `git config --worktree` |
| `calblue.sessionId` | which run owns it, so a stale claim is distinguishable from a live one |
| `calblue.allowedBranchRegex` | e.g. `^(chore\|feat\|fix)/.*-cc$` — stops you committing to another agent's branch from your own worktree |
| `calblue.readOnly` | set on the shared clone; makes it reject all commits |

```sh
python3 .git/hooks/agent-guard.py status    # what this worktree is configured as
python3 .git/hooks/agent-guard.py claim     # take the lease
python3 .git/hooks/agent-guard.py release   # give it back when finished
```

Doing the setup by hand is easy to get subtly wrong in one specific way: **the branch must track its
own remote ref.** A worktree created with `git worktree add -b <branch> <dir> origin/main` tracks
`origin/main`, and the guard then refuses every commit with a message about the upstream that does
not obviously mean "push your branch first". Bootstrap it with
`git push --no-verify -u origin <branch>` before the first commit — nothing is committed at that
point, so `--no-verify` bypasses nothing real.

## Why each rule exists

Each of these is a mistake that has actually happened here, not a hypothetical.

**Never work in `~/calblue-website`.** It is the directory every agent reaches for by default. On
2026-08-25 it switched from `main` to another agent's branch mid-session; on 2026-08-29 it was
sitting on `feat/wave5-12-muse`. Any agent opening it inherits someone else's branch and working
tree without knowing.

**One worktree per unit of work.** On 2026-08-29 `.gh/status.py` was refactored inside `cc`'s
worktree by another agent while `cc` was editing the same lines. Both produced the same fix
independently; the duplication only surfaced as a rebase conflict. Nothing was lost, but by luck.

**Base off `origin/main`, explicitly.** Branching off whatever is checked out is how one agent's
half-finished work ends up in another's PR. A `git add -A` in a directory another agent had been
writing to swept that agent's uncommitted refactor into an unrelated commit.

**Suffix the branch with your agent tag.** Every PR here is authored by the same GitHub account, so
commit authorship tells a reviewer nothing. The branch suffix is the only durable signal of who did
the work, and `.gh/label_prs.py` derives the `[cc]`/`[codex]`/`[muse]` PR title tags from it.

**Do not change shared git config.** Config set without `--worktree` applies to every worktree.
Setting `core.hooksPath` to point at a project directory silently disabled `agent-guard.py` for all
three agents — that was done once, during the writing of this file, and caught only because the
existing hooks were inspected afterwards. If you need a hook, add it to `.git/hooks/`, do not
redirect the path.

## When you find a problem

`check_worktrees.py` prints remediation rather than running it, deliberately. Moving or resetting
another agent's worktree while that agent is mid-session is exactly the interference the convention
exists to prevent. Read the output, confirm the owning agent is not running, then act.

**Another agent has written into your worktree.** Do not revert their work — it may be the only
copy. Commit or stash your own changes first, then look at what arrived. If it duplicates something
you already pushed, prefer theirs and drop yours; a rebase conflict is the usual way this surfaces.

**You are about to force-push a branch others have stacked on.** Don't, until you have checked what
is based on it. `.gh/status.py` prints the PR stack with each PR's base.

## What none of this can do

Nothing here stops another process writing into your directory. There is no filesystem locking, and
an agent that does not read this file will not follow it. The guarantee is that the state is
inspectable and that the common mistakes fail loudly instead of quietly.
