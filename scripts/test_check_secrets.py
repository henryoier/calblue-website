#!/usr/bin/env python3
"""Unit tests for scripts/check_secrets.py."""

from __future__ import annotations

import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_secrets  # noqa: E402


def encoded(value: dict) -> bytes:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def fake_jwt(role: str) -> bytes:
    return b".".join((encoded({"alg": "HS256", "typ": "JWT"}), encoded({"role": role}), b"fake_signature"))


class SecretScannerTest(unittest.TestCase):
    def test_allows_documented_placeholder(self):
        data = f"{check_secrets.SERVICE_KEY_NAME}=YOUR_SUPABASE_SERVICE_ROLE_KEY\n".encode()
        self.assertEqual(check_secrets.scan_bytes(data), [])

    def test_rejects_new_secret_key_prefix(self):
        data = ("token=" + check_secrets.SECRET_PREFIX + "not-a-real-key").encode()
        self.assertIn("contains a Supabase secret-key prefix", check_secrets.scan_bytes(data))

    def test_rejects_legacy_service_role_jwt(self):
        findings = check_secrets.scan_bytes(b"token=" + fake_jwt("service_role"))
        self.assertIn("contains a legacy Supabase service-role JWT", findings)

    def test_allows_anon_jwt(self):
        self.assertEqual(check_secrets.scan_bytes(b"token=" + fake_jwt("anon")), [])

    def test_rejects_non_placeholder_service_assignment(self):
        data = f"{check_secrets.SERVICE_KEY_NAME}=super-sensitive-value\n".encode()
        self.assertIn(
            f"assigns a non-placeholder {check_secrets.SERVICE_KEY_NAME}",
            check_secrets.scan_bytes(data),
        )

    def test_repository_scan_rejects_a_tracked_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
            leak = root / "leak.txt"
            leak.write_text(check_secrets.SECRET_PREFIX + "tracked-example-key", encoding="utf-8")
            subprocess.run(["git", "add", "leak.txt"], cwd=root, check=True)

            violations = check_secrets.check_repository(root)

            self.assertEqual(len(violations), 1)
            self.assertEqual(violations[0][0], leak)
            self.assertEqual(violations[0][1], "contains a Supabase secret-key prefix")


if __name__ == "__main__":
    unittest.main()
