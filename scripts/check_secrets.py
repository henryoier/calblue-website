#!/usr/bin/env python3
"""Reject recognizable Supabase service credentials before publishing.

Inspect Git's index and current tracked/nonignored untracked files, including generated files.
Ignored private files and Git history are not scanned. UTF-8 and UTF-16 text are supported;
this is not a general secret scanner and does not unpack archives or reconstruct obfuscated keys.
Keep private files outside the static server's document root: Git ignores are not access control.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
SECRET_PREFIX = "sb_" + "secret_"
SERVICE_KEY_NAME = "SUPABASE_" + "SERVICE_ROLE_KEY"
SECRET_RE = re.compile((SECRET_PREFIX + r"[A-Za-z0-9_-]{8,}").encode("ascii"))
JWT_RE = re.compile(
    rb"(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])"
)
ASSIGNMENT_RE = re.compile(
    rf"(?m)^[ \t]*(?:export[ \t]+)?{re.escape(SERVICE_KEY_NAME)}[ \t]*=[ \t]*([^\r\n]*)\r?$"
)
VARIABLE_REFERENCE_RE = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})")
PLACEHOLDERS = {"YOUR_" + SERVICE_KEY_NAME, "<" + SERVICE_KEY_NAME + ">", "PLACEHOLDER"}


def git_bytes(root: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout


def repository_files(root: Path) -> list[Path]:
    """NUL-safe, root-relative discovery; ignored files are excluded unless already tracked."""
    names = git_bytes(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    return [root / os.fsdecode(name) for name in sorted(set(names.split(b"\0")) - {b""})]


def indexed_files(root: Path) -> list[tuple[Path, str, str]]:
    """Return path/mode/blob entries, including every stage of an unresolved merge."""
    entries = []
    for entry in git_bytes(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, object_id, _stage = metadata.decode("ascii").split()
        entries.append((root / os.fsdecode(name), mode, object_id))
    return entries


def decode_jwt_payload(token: bytes) -> Optional[dict]:
    try:
        payload = token.split(b".", 2)[1]
        payload += b"=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload)
        value = json.loads(decoded)
    except (ValueError, binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def looks_like_placeholder(value: str) -> bool:
    return not value or value in PLACEHOLDERS


def assignment_value(value: str) -> str:
    """Remove a shell/dotenv comment and matching quotes, without evaluating anything."""
    quote = None
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote != "'":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in "'\"":
            quote = char
        elif char == "#" and (index == 0 or value[index - 1].isspace()):
            value = value[:index]
            break
    value = value.strip()
    if len(value) >= 2 and value[0] in "'\"" and value[-1] == value[0]:
        value = value[1:-1]
    return value


def text_versions(data: bytes):
    # UTF-8 also preserves recognizable ASCII key signatures embedded in otherwise binary data.
    yield data.decode("utf-8-sig", errors="ignore")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        encodings = ("utf-16",)
    elif b"\0" in data:
        encodings = ("utf-16-le", "utf-16-be")
    else:
        encodings = ()
    for encoding in encodings:
        try:
            yield data.decode(encoding)
        except UnicodeError:
            continue


def scan_bytes(data: bytes) -> list[str]:
    findings: list[str] = []
    for text in text_versions(data):
        encoded = text.encode("utf-8")
        if SECRET_RE.search(encoded):
            findings.append("contains a Supabase secret-key prefix")

        for match in JWT_RE.finditer(encoded):
            payload = decode_jwt_payload(match.group(1))
            if payload and payload.get("role") == "service_role":
                findings.append("contains a legacy Supabase service-role JWT")
                break

        for match in ASSIGNMENT_RE.finditer(text):
            value = assignment_value(match.group(1))
            if not looks_like_placeholder(value) and not VARIABLE_REFERENCE_RE.fullmatch(value):
                findings.append(f"assigns a non-placeholder {SERVICE_KEY_NAME}")
                break
    return list(dict.fromkeys(findings))


def redacted_path(path: Path) -> Path:
    """Even an unusual filename containing a recognizable key must not disclose it in logs."""
    value = os.fsencode(path)
    value = SECRET_RE.sub(b"[REDACTED]", value)
    for match in list(JWT_RE.finditer(value)):
        payload = decode_jwt_payload(match.group(1))
        if payload and payload.get("role") == "service_role":
            value = value.replace(match.group(1), b"[REDACTED]")
    return Path(os.fsdecode(value))


def is_within_root(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def check_repository(root: Path) -> list[tuple[Path, str]]:
    root = root.resolve()
    violations: list[tuple[Path, str]] = []
    blob_cache: dict[str, bytes] = {}
    for path, mode, object_id in indexed_files(root):
        shown = redacted_path(path)
        try:
            if object_id not in blob_cache:
                blob_cache[object_id] = git_bytes(root, "cat-file", "blob", object_id)
            data = blob_cache[object_id]
        except (OSError, subprocess.CalledProcessError):
            violations.append((shown, "could not read Git index content"))
            continue
        for finding in scan_bytes(data):
            violations.append((shown, finding))
        if mode == "120000" and not is_within_root(path.parent / os.fsdecode(data), root):
            violations.append((shown, "indexed symbolic link points outside the repository; target not read"))

    for path in repository_files(root):
        shown = redacted_path(path)
        if not is_within_root(path, root):
            violations.append((shown, "symbolic link resolves outside the repository; target not read"))
            continue
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            if path.is_symlink():
                violations.append((shown, "symbolic link has no readable target"))
            # A removed tracked file was still checked in the index above.
            continue
        except OSError:
            violations.append((shown, "could not read repository file"))
            continue
        for finding in scan_bytes(data):
            violations.append((shown, finding))
    return list(dict.fromkeys(violations))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Git worktree to inspect")
    args = parser.parse_args()

    try:
        violations = check_repository(args.root.resolve())
    except (OSError, subprocess.CalledProcessError):
        print("check_secrets: could not inspect repository files or Git index", file=sys.stderr)
        return 2

    if violations:
        print("check_secrets: FAILED", file=sys.stderr)
        for path, finding in violations:
            try:
                shown = path.relative_to(args.root.resolve())
            except ValueError:
                shown = path
            print(f"  {shown}: {finding}", file=sys.stderr)
        print("Remove credentials from both the index and working tree; rotate any exposed key. "
              "Git history requires a separate review if a key was committed.", file=sys.stderr)
        return 1

    print("check_secrets: ok (Git index and tracked/nonignored working-tree files; "
          "ignored private files and history excluded)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
