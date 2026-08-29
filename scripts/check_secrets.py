#!/usr/bin/env python3
"""Reject Supabase service credentials in tracked repository files."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
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


def tracked_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    )
    return [root / name.decode("utf-8") for name in result.stdout.split(b"\0") if name]


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
    normalized = value.strip().strip("'\"")
    return (
        not normalized
        or normalized.startswith("YOUR_")
        or normalized.startswith("<")
        or "PLACEHOLDER" in normalized.upper()
    )


def scan_bytes(data: bytes) -> list[str]:
    findings: list[str] = []
    if SECRET_RE.search(data):
        findings.append("contains a Supabase secret-key prefix")

    for match in JWT_RE.finditer(data):
        payload = decode_jwt_payload(match.group(1))
        if payload and payload.get("role") == "service_role":
            findings.append("contains a legacy Supabase service-role JWT")
            break

    text = data.decode("utf-8", errors="ignore")
    assignment_re = re.compile(rf"(?m)^\s*{re.escape(SERVICE_KEY_NAME)}\s*=\s*(.*?)\s*$")
    for match in assignment_re.finditer(text):
        if not looks_like_placeholder(match.group(1)):
            findings.append(f"assigns a non-placeholder {SERVICE_KEY_NAME}")
            break
    return findings


def check_repository(root: Path) -> list[tuple[Path, str]]:
    violations: list[tuple[Path, str]] = []
    for path in tracked_files(root):
        try:
            data = path.read_bytes()
        except OSError as exc:
            violations.append((path, f"could not read tracked file: {exc}"))
            continue
        for finding in scan_bytes(data):
            violations.append((path, finding))
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Git worktree to inspect")
    args = parser.parse_args()

    try:
        violations = check_repository(args.root.resolve())
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"check_secrets: could not enumerate tracked files: {exc}", file=sys.stderr)
        return 2

    if violations:
        print("check_secrets: FAILED", file=sys.stderr)
        for path, finding in violations:
            try:
                shown = path.relative_to(args.root.resolve())
            except ValueError:
                shown = path
            print(f"  {shown}: {finding}", file=sys.stderr)
        print("Remove the credential, rotate it, and purge it from Git history if committed.", file=sys.stderr)
        return 1

    count = len(tracked_files(args.root.resolve()))
    print(f"check_secrets: ok ({count} tracked files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
