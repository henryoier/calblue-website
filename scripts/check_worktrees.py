#!/usr/bin/env python3
"""Inventory the git worktrees on this machine and report agent-isolation problems.

    python3 scripts/check_worktrees.py

Enforcement lives in `.git/hooks/agent-guard.py`, which holds a per-worktree lease and refuses
commits from the wrong agent, the wrong branch, or an unclaimed worktree. This script does not
duplicate that. It answers the question the guard cannot, because the guard only ever sees the
worktree it is invoked from: **what does the whole machine look like right now, and is every agent
actually isolated?**

It reports; it does not fix. Moving or resetting another agent's worktree while that agent is
mid-session is precisely the interference the convention exists to prevent, so remediation is
printed for a human to run. See docs/AGENTS.md.
"""

import os
import pathlib
import re
import subprocess
import sys

SHARED = pathlib.Path.home() / "calblue-website"
AGENTS = ("cc", "codex", "muse")
WT_NAME = re.compile(r"^calblue-wt-(?P<slug>.+)-(?P<agent>" + "|".join(AGENTS) + r")$")
BRANCH_SUFFIX = re.compile(r"-(?:" + "|".join(AGENTS) + r")$")


def git(args, cwd=None):
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True).stdout.strip()


def worktrees():
    """Parse `git worktree list --porcelain` into dicts."""
    out, current = [], {}
    for line in git(["worktree", "list", "--porcelain"], cwd=SHARED).splitlines():
        if not line:
            if current:
                out.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current["path"] = pathlib.Path(value)
        elif key == "branch":
            current["branch"] = value.replace("refs/heads/", "")
        elif key == "detached":
            current["detached"] = True
    if current:
        out.append(current)
    return out


def guard_state(path):
    """What agent-guard.py would make of this worktree."""
    agent = git(["config", "--get", "calblue.agent"], cwd=path)
    upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd=path)
    branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd=path)
    common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=path)
    git_dir = git(["rev-parse", "--path-format=absolute", "--git-dir"], cwd=path)
    claimed = bool(git_dir) and (pathlib.Path(git_dir) / "agent-claim.json").exists()
    read_only = git(["config", "--get", "calblue.readOnly"], cwd=path).lower() == "true"
    upstream_ok = (not branch) or upstream == f"origin/{branch}"
    return {"agent": agent, "claimed": claimed, "read_only": read_only,
            "upstream_ok": upstream_ok, "upstream": upstream,
            "guard": pathlib.Path(common) / "hooks" / "agent-guard.py" if common else None}


def dirty(path):
    changed = git(["status", "--porcelain"], cwd=path).splitlines()
    return [c for c in changed if "__pycache__" not in c]


def unpushed(path, branch):
    if not branch:
        return 0
    count = git(["rev-list", "--count", f"origin/{branch}..{branch}"], cwd=path)
    return int(count) if count.isdigit() else 0


def main():
    if not SHARED.exists():
        print(f"check_worktrees: {SHARED} not found — nothing to check")
        return 0

    problems, notes, rows = [], [], []

    for wt in worktrees():
        path = wt["path"]
        branch = wt.get("branch")
        name = path.name
        is_shared = path == SHARED
        d, u = dirty(path), unpushed(path, branch)

        # who owns it, by directory name then by branch suffix
        m = WT_NAME.match(name)
        owner = m.group("agent") if m else None
        if not owner and branch:
            suffix = BRANCH_SUFFIX.search(branch)
            owner = suffix.group(0)[1:] if suffix else None

        g = guard_state(path)
        owner = owner or g["agent"] or None
        rows.append((name, branch or f"DETACHED {git(['rev-parse', '--short', 'HEAD'], path)}",
                     owner or "?", len(d), u, g))

        # the guard is the enforcement layer; an unconfigured worktree is not protected by it
        if not is_shared and not g["read_only"]:
            if not g["agent"]:
                problems.append(
                    f"{name}: no calblue.agent configured, so agent-guard.py will refuse every "
                    f"commit here and nothing records who owns it.\n"
                    f"        git -C {path} config calblue.agent <cc|codex|muse>")
            elif not g["claimed"]:
                notes.append(f"{name}: configured for '{g['agent']}' but the worktree is unclaimed "
                             f"— run agent-guard.py claim")
            if branch and not g["upstream_ok"]:
                problems.append(
                    f"{name}: branch '{branch}' tracks '{g['upstream'] or 'nothing'}', but the "
                    f"guard expects 'origin/{branch}'. Commits will be refused.\n"
                    f"        git -C {path} push --no-verify -u origin {branch}")

        if is_shared:
            if branch != "main":
                problems.append(
                    f"{name}: the shared reference clone is on '{branch}', not 'main'.\n"
                    f"      Every agent reaches for this directory by default and will find "
                    f"somebody else's branch.\n"
                    f"      Fix (only when {owner or 'its owner'} is not running):\n"
                    f"        git -C {SHARED} worktree add ~/calblue-wt-{branch.split('/')[-1]} {branch}\n"
                    f"        git -C {SHARED} checkout main")
            if d:
                problems.append(f"{name}: shared clone has {len(d)} uncommitted file(s); "
                                f"it should always be clean")
            continue

        if wt.get("detached"):
            problems.append(
                f"{name}: detached HEAD. Commits here belong to no branch and are easy to lose.\n"
                f"        git -C {path} switch -c <type>/<slug>-<agent>")
        elif branch and not BRANCH_SUFFIX.search(branch):
            notes.append(f"{name}: branch '{branch}' has no agent suffix, so ownership is "
                         f"not visible from the branch name alone")

        if not m:
            notes.append(f"{name}: directory name does not match "
                         f"calblue-wt-<slug>-<agent>, so ownership is ambiguous")
        if d:
            notes.append(f"{name}: {len(d)} uncommitted file(s) — at risk if another agent "
                         f"writes here")
        if u:
            notes.append(f"{name}: {u} unpushed commit(s) — invisible to the other agents")

    # two worktrees claiming the same issue number
    by_issue = {}
    for name, branch, owner, _, _, _ in rows:
        for num in re.findall(r"\b(\d{2,3})\b", branch):
            by_issue.setdefault(num, []).append(name)
    for num, names in by_issue.items():
        if len(names) > 1:
            notes.append(f"branches referencing #{num} in more than one worktree: {', '.join(names)}")

    width = max(len(r[0]) for r in rows)
    print("Worktrees\n")
    print(f"  {'directory'.ljust(width)}  {'branch'.ljust(30)} owner  claim  dirty  unpushed")
    for name, branch, owner, d, u, g in rows:
        if pathlib.Path.home() / name == SHARED:
            claim = "n/a"
        else:
            claim = "held" if g["claimed"] else "-"
        flag = "  <-- shared, read-only" if pathlib.Path.home() / name == SHARED else ""
        print(f"  {name.ljust(width)}  {branch[:30].ljust(30)} {owner.ljust(6)} "
              f"{claim.ljust(6)} {str(d).ljust(6)} {u}{flag}")

    if notes:
        print("\nNotes")
        for n in notes:
            print(f"  - {n}")

    if problems:
        print("\ncheck_worktrees: FAILED\n")
        for p in problems:
            print(f"  ! {p}\n")
        return 1

    print("\ncheck_worktrees: ok — every agent is isolated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
