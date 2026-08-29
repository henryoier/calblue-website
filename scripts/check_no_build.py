#!/usr/bin/env python3
"""Enforce ADR 0001: the repository has no JavaScript build step.

Run from the repository root:  python3 scripts/check_no_build.py

This exists so that the decision in docs/design/adr/0001-client-stack.md fails loudly if somebody
reaches for a bundler, rather than being quietly eroded.
"""
import pathlib
import subprocess
import sys

FORBIDDEN_FILES = {
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
    "tsconfig.json", "vite.config.js", "vite.config.ts", "webpack.config.js",
    "rollup.config.js", "svelte.config.js", "next.config.js",
}
FORBIDDEN_DIRS = {"node_modules", "dist", ".next", ".svelte-kit"}


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return [pathlib.Path(p) for p in out.splitlines() if p]


def main():
    problems = []
    for path in tracked_files():
        if path.name in FORBIDDEN_FILES:
            problems.append(f"{path}: build-tooling file (see ADR 0001)")
        for part in path.parts:
            if part in FORBIDDEN_DIRS:
                problems.append(f"{path}: lives under {part}/ (see ADR 0001)")
                break

    # ES modules need explicit extensions in the browser; a bare specifier means a bundler is assumed.
    for path in tracked_files():
        if path.suffix != ".js" or not str(path).startswith("app/"):
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            stripped = line.strip()
            if not stripped.startswith(("import ", "export ")) or " from " not in stripped:
                continue
            spec = stripped.rsplit(" from ", 1)[1].strip().rstrip(";").strip("\"'")
            if spec.startswith(("./", "../")) and not spec.endswith(".js"):
                problems.append(f"{path}:{lineno}: relative import without a .js extension: {spec}")
            elif not spec.startswith((".", "http://", "https://")):
                problems.append(f"{path}:{lineno}: bare module specifier needs a bundler: {spec}")

    if problems:
        print("check_no_build: FAILED")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"check_no_build: ok ({len(tracked_files())} tracked files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
