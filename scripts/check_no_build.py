#!/usr/bin/env python3
"""Enforce ADR 0001: the repository has no JavaScript build step.

Run from any working directory: python3 /path/to/repo/scripts/check_no_build.py

This exists so that the decision in docs/design/adr/0001-client-stack.md fails loudly if somebody
reaches for a bundler, rather than being quietly eroded.

Checks tracked/indexed and nonignored untracked paths, plus app JavaScript's static imports,
re-exports and literal dynamic imports. This is a conventions check, not a JavaScript parser or
security scanner: computed imports and expressions inside template literals need code review.
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

FORBIDDEN_FILES = {
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "bun.lockb", "bun.lock", "bunfig.toml", "deno.json", "deno.jsonc",
    "deno.lock", "tsconfig.json", "jsconfig.json", ".babelrc", ".babelrc.json", ".parcelrc",
    ".yarnrc.yml", "turbo.json", "lerna.json",
}
FORBIDDEN_DIRS = {"node_modules", "dist", ".next", ".svelte-kit"}
CONFIG_FILE = re.compile(
    r"(?:vite|vitest|webpack|rollup|svelte|next|nuxt|astro|babel|esbuild|rspack|tsup)"
    r"\.config\.(?:[cm]?[jt]s|json)$"
    r"|(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json$"
)

# Keep comments and quoted examples as whole tokens so they cannot masquerade as imports.
# Template expressions are deliberately not parsed; this also avoids treating a constructed
# dependency URL as a literal. Module specifier escapes are left literal and fail conservatively.
JS_TOKENS = re.compile(
    r"(?P<comment>//[^\n]*|/\*[\s\S]*?\*/)"
    r"|(?P<string>\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\])*')"
    r"|(?P<template>`(?:\\[\s\S]|[^`\\])*`)"
    r"|(?P<word>[$A-Za-z_][$\w]*)"
    r"|(?P<symbol>[^\s])"
)


def repository_files(root=ROOT):
    """Return stable, root-relative paths; Git's exclusions also apply to untracked files."""
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root, capture_output=True, text=True, check=True,
    ).stdout
    return [pathlib.Path(path) for path in sorted(set(out.split("\0")) - {""})]


def module_specifiers(source):
    """Yield (line number, specifier) for supported literal import/re-export syntax."""
    tokens = [token for token in JS_TOKENS.finditer(source) if token.lastgroup != "comment"]
    for index, token in enumerate(tokens):
        keyword = token.group()
        if token.lastgroup != "word" or keyword not in {"import", "export"}:
            continue
        if index and tokens[index - 1].group() == ".":
            continue  # obj.import(...) and import.meta are not module declarations.
        rest = tokens[index + 1:]
        if not rest:
            continue

        specifier = None
        if keyword == "import" and rest[0].lastgroup == "string":
            specifier = rest[0]  # import "./side-effect.js"
        elif keyword == "import" and rest[0].group() == "(":
            if len(rest) > 1 and rest[1].lastgroup in {"string", "template"}:
                candidate = rest[1]
                if candidate.lastgroup != "template" or "${" not in candidate.group():
                    # Only a literal expression, not import("./" + moduleName).
                    if len(rest) > 2 and rest[2].group() in {")", ","}:
                        specifier = candidate
        elif rest[0].group() in {"{", "*"} or (
            keyword == "import" and rest[0].lastgroup == "word"
        ):
            # Covers multiline named/default imports and `export { ... } from` / `export * from`.
            for offset, candidate in enumerate(rest):
                if candidate.group() == ";":
                    break
                if candidate.group() == "from" and offset + 1 < len(rest):
                    if rest[offset + 1].lastgroup == "string":
                        specifier = rest[offset + 1]
                        break
                if candidate.lastgroup == "word" and candidate.group() in {"import", "export"}:
                    break

        if specifier is not None:
            yield source.count("\n", 0, token.start()) + 1, specifier.group()[1:-1]


def import_problems(path, source):
    for lineno, spec in module_specifiers(source):
        if spec.startswith(("./", "../", "/")) and not spec.startswith("//"):
            # Queries and fragments are valid browser imports; the pathname still needs .js.
            pathname = spec.split("?", 1)[0].split("#", 1)[0]
            if not pathname.endswith(".js"):
                yield f"{path}:{lineno}: local import without a .js extension: {spec}"
        elif not spec.startswith(("http://", "https://", "//")):
            yield f"{path}:{lineno}: bare module specifier needs a bundler or import map: {spec}"


def check_repository(root=ROOT):
    paths = repository_files(root)
    problems = []
    for path in paths:
        if path.name in FORBIDDEN_FILES or CONFIG_FILE.fullmatch(path.name):
            problems.append(f"{path}: build-tooling file (see ADR 0001)")
        for part in path.parts:
            if part in FORBIDDEN_DIRS:
                problems.append(f"{path}: lives under {part}/ (see ADR 0001)")
                break

        if path.suffix not in {".js", ".mjs", ".cjs"} or path.parts[0] != "app":
            continue
        full_path = root / path
        if not full_path.is_file():
            continue  # A tracked file may have been removed in the working tree.
        try:
            source = full_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            problems.append(f"{path}: cannot read JavaScript: {error}")
            continue
        problems.extend(import_problems(path, source))
    return problems, len(paths)


def main():
    try:
        problems, count = check_repository()
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"check_no_build: FAILED to list repository files: {error}")
        return 1
    if problems:
        print("check_no_build: FAILED")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"check_no_build: ok ({count} tracked and nonignored untracked files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
