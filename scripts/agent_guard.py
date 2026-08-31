#!/usr/bin/env python3
"""Refuse commits and pushes from unclaimed or incorrectly owned worktrees."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys


def run_git(*args: str, required: bool = True) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if required and result.returncode:
        raise SystemExit(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip() if result.returncode == 0 else ""


def worktree_config(key: str) -> str:
    return run_git("config", "--worktree", "--get", key, required=False)


def fail(message: str) -> None:
    print(f"CalBlue agent guard: {message}", file=sys.stderr)
    raise SystemExit(1)


def state() -> dict[str, str | bool | Path]:
    root = Path(run_git("rev-parse", "--show-toplevel")).resolve()
    git_dir = Path(run_git("rev-parse", "--path-format=absolute", "--git-dir")).resolve()
    branch = run_git("symbolic-ref", "--quiet", "--short", "HEAD", required=False)
    upstream = run_git(
        "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}", required=False
    )
    return {
        "root": root,
        "git_dir": git_dir,
        "claim": git_dir / "agent-claim.json",
        "branch": branch,
        "agent": worktree_config("calblue.agent"),
        "session": worktree_config("calblue.sessionId"),
        "pattern": worktree_config("calblue.allowedBranchRegex"),
        "upstream": upstream,
        "read_only": worktree_config("calblue.readOnly").lower() == "true",
    }


def validate_configuration(current: dict[str, str | bool | Path]) -> None:
    if current["read_only"]:
        fail(
            f"{current['root']} is the read-only integration checkout; "
            "create an agent worktree with scripts/agent_worktree.sh"
        )
    for key in ("agent", "session", "pattern"):
        if not current[key]:
            fail(f"{current['root']} is missing worktree config calblue.{key}")
    branch = str(current["branch"])
    if not branch:
        fail(f"{current['root']} is on a detached HEAD")
    if re.fullmatch(str(current["pattern"]), branch) is None:
        fail(
            f"branch '{branch}' is not owned by {current['agent']}; "
            f"allowed pattern: {current['pattern']}"
        )
    upstream = str(current["upstream"])
    if upstream and upstream != f"origin/{branch}":
        fail(f"branch '{branch}' tracks '{upstream}', expected 'origin/{branch}'")


def expected_claim(current: dict[str, str | bool | Path]) -> dict[str, str]:
    return {
        "root": str(current["root"]),
        "branch": str(current["branch"]),
        "agent": str(current["agent"]),
        "session": str(current["session"]),
    }


def load_claim(path: Path) -> dict[str, str]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"no claim exists for this worktree; run agent-guard.py claim")
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read claim {path}: {error}")


def claim() -> None:
    current = state()
    validate_configuration(current)
    path = current["claim"]
    expected = expected_claim(current)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        existing = load_claim(path)
        if existing != expected:
            fail(
                f"{current['root']} is already claimed by "
                f"{existing.get('agent')}/{existing.get('session')} "
                f"on {existing.get('branch')}"
            )
        print(
            f"claim already held: {expected['agent']}/{expected['session']} "
            f"on {expected['branch']}"
        )
        return
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(expected, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(
        f"claimed {expected['root']} for {expected['agent']}/"
        f"{expected['session']} on {expected['branch']}"
    )


def check() -> dict[str, str | bool | Path]:
    current = state()
    validate_configuration(current)
    existing = load_claim(current["claim"])
    expected = expected_claim(current)
    if existing != expected:
        fail(f"claim mismatch: expected {expected}, found {existing}")
    return current


def check_push() -> None:
    current = check()
    pattern = re.compile(str(current["pattern"]))
    for line in sys.stdin:
        fields = line.split()
        if len(fields) != 4:
            continue
        local_ref, _local_sha, remote_ref, _remote_sha = fields
        for ref in (local_ref, remote_ref):
            if ref.startswith("refs/heads/"):
                branch = ref.removeprefix("refs/heads/")
                if pattern.fullmatch(branch) is None:
                    fail(
                        f"{current['agent']} cannot push branch '{branch}'; "
                        f"allowed pattern: {current['pattern']}"
                    )


def release() -> None:
    current = check()
    if run_git("status", "--porcelain"):
        fail("worktree is dirty; commit, stash, or clean it before release")
    Path(current["claim"]).unlink()
    print(f"released {current['root']}")


def show_status() -> None:
    current = state()
    print(f"root: {current['root']}")
    print(f"branch: {current['branch'] or 'DETACHED'}")
    print(f"upstream: {current['upstream'] or '(none yet)'}")
    print(f"agent: {current['agent'] or '(unconfigured)'}")
    print(f"session: {current['session'] or '(unconfigured)'}")
    print(f"allowed: {current['pattern'] or '(unconfigured)'}")
    print(f"read-only: {current['read_only']}")
    claim_path = Path(current["claim"])
    print(f"claim: {claim_path if claim_path.exists() else '(none)'}")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "claim":
        claim()
    elif command == "check":
        check()
    elif command == "check-push":
        check_push()
    elif command == "release":
        release()
    elif command == "status":
        show_status()
    else:
        fail(f"unknown command '{command}'")


if __name__ == "__main__":
    main()
