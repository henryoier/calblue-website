#!/usr/bin/env python3
"""Unit tests for scripts/check_secrets.py."""

from __future__ import annotations

import base64
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


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

    def test_allows_publishable_key(self):
        public_key = "sb_" + "publishable_" + "synthetic_public_example"
        self.assertEqual(check_secrets.scan_bytes(public_key.encode()), [])

    def test_rejects_non_placeholder_service_assignment(self):
        data = f"{check_secrets.SERVICE_KEY_NAME}=super-sensitive-value\n".encode()
        self.assertIn(
            f"assigns a non-placeholder {check_secrets.SERVICE_KEY_NAME}",
            check_secrets.scan_bytes(data),
        )

    def test_detects_utf8_and_utf16_text_keys(self):
        keys = [fake_jwt("service_role").decode(), check_secrets.SECRET_PREFIX + "synthetic_example"]
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
            for key in keys:
                with self.subTest(encoding=encoding, kind="JWT" if "." in key else "prefix"):
                    self.assertTrue(check_secrets.scan_bytes(key.encode(encoding)))

    def test_detects_exported_assignments_and_bom(self):
        value = f"export {check_secrets.SERVICE_KEY_NAME}=synthetic-opaque-value\n"
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
            with self.subTest(encoding=encoding):
                self.assertTrue(check_secrets.scan_bytes(value.encode(encoding)))

    def test_allows_empty_commented_and_direct_variable_references(self):
        values = ["", "# intentionally unset", '"" # unset', "''", "$JOB_SECRET",
                  "${JOB_SECRET}", '"${JOB_SECRET}" # provided by runner',
                  "YOUR_" + check_secrets.SERVICE_KEY_NAME, "PLACEHOLDER"]
        for value in values:
            with self.subTest(kind="allowed assignment"):
                source = f"export {check_secrets.SERVICE_KEY_NAME}={value}\n"
                self.assertEqual(check_secrets.scan_bytes(source.encode()), [])

    def test_placeholder_recognition_is_exact(self):
        values = ["synthetic-PLACEHOLDER-value", "YOUR_not-a-documented-placeholder", "<opaque-value>"]
        for value in values:
            source = f"{check_secrets.SERVICE_KEY_NAME}={value}\n"
            self.assertTrue(check_secrets.scan_bytes(source.encode()))

    def test_comments_inside_quotes_do_not_hide_values(self):
        source = f"{check_secrets.SERVICE_KEY_NAME}='opaque # value' # comment\n"
        self.assertTrue(check_secrets.scan_bytes(source.encode()))

    def test_empty_assignment_does_not_consume_the_next_line(self):
        source = f"{check_secrets.SERVICE_KEY_NAME}=\nPUBLIC_SETTING=value\n"
        self.assertEqual(check_secrets.scan_bytes(source.encode()), [])

    def test_crlf_assignments_are_scanned(self):
        source = f"PUBLIC_SETTING=value\r\nexport {check_secrets.SERVICE_KEY_NAME}=opaque-value\r\n"
        self.assertTrue(check_secrets.scan_bytes(source.encode()))
        safe = f"{check_secrets.SERVICE_KEY_NAME}= # unset\r\nPUBLIC_SETTING=value\r\n"
        self.assertEqual(check_secrets.scan_bytes(safe.encode()), [])

    def test_signature_in_comment_is_still_rejected(self):
        source = f"{check_secrets.SERVICE_KEY_NAME}= # " + check_secrets.SECRET_PREFIX + "synthetic_example"
        self.assertTrue(check_secrets.scan_bytes(source.encode()))

    def test_findings_never_contain_the_credential(self):
        key = check_secrets.SECRET_PREFIX + "synthetic_redaction_example"
        findings = check_secrets.scan_bytes(key.encode())
        self.assertTrue(findings)
        self.assertNotIn(key, "\n".join(findings))


class RepositoryScannerTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True)
        self.key = check_secrets.SECRET_PREFIX + "synthetic_repository_example"

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def stage(self, name):
        subprocess.run(["git", "add", "--", name], cwd=self.root, check=True)

    def test_rejects_a_tracked_key_without_duplicate_findings(self):
        leak = self.write("leak.txt", self.key)
        self.stage("leak.txt")
        self.assertEqual(check_secrets.check_repository(self.root), [
            (leak, "contains a Supabase secret-key prefix"),
        ])

    def test_scans_index_even_when_working_copy_is_clean(self):
        self.write("staged.txt", self.key)
        self.stage("staged.txt")
        self.write("staged.txt", "safe working copy")
        self.assertTrue(check_secrets.check_repository(self.root))

    def test_scans_changed_working_copy_with_clean_index(self):
        self.write("changed.txt", "safe index")
        self.stage("changed.txt")
        self.write("changed.txt", self.key)
        self.assertTrue(check_secrets.check_repository(self.root))

    def test_scans_visible_untracked_generated_files(self):
        leak = self.write("generated/config.txt", self.key)
        self.assertEqual(check_secrets.check_repository(self.root)[0][0], leak)

    def test_ignored_private_files_are_excluded(self):
        self.write(".gitignore", ".env*\n!.env.example\n")
        self.write(".env", self.key)
        self.assertEqual(check_secrets.check_repository(self.root), [])

    def test_already_tracked_private_file_is_not_exempted(self):
        self.write(".env", self.key)
        self.stage(".env")
        self.write(".gitignore", ".env*\n")
        self.assertTrue(check_secrets.check_repository(self.root))

    def test_removed_safe_tracked_file_does_not_fail(self):
        path = self.write("removed.txt", "safe index")
        self.stage("removed.txt")
        path.unlink()
        self.assertEqual(check_secrets.check_repository(self.root), [])

    def test_removed_working_file_still_has_its_index_scanned(self):
        path = self.write("removed.txt", self.key)
        self.stage("removed.txt")
        path.unlink()
        self.assertTrue(check_secrets.check_repository(self.root))

    def test_removal_from_index_and_working_tree_does_not_fail(self):
        path = self.write("removed.txt", self.key)
        self.stage("removed.txt")
        subprocess.run(["git", "rm", "--cached", "--quiet", "--", "removed.txt"],
                       cwd=self.root, check=True)
        path.unlink()
        self.assertEqual(check_secrets.check_repository(self.root), [])

    def test_removal_from_index_does_not_hide_remaining_working_file(self):
        self.write("remaining.txt", self.key)
        self.stage("remaining.txt")
        subprocess.run(["git", "rm", "--cached", "--quiet", "--", "remaining.txt"],
                       cwd=self.root, check=True)
        self.assertTrue(check_secrets.check_repository(self.root))

    def test_null_separated_paths_with_whitespace_and_unicode(self):
        name = "folder/snow 雪\tline\nexample.txt"
        leak = self.write(name, self.key)
        self.stage(name)
        self.assertEqual(check_secrets.check_repository(self.root)[0][0], leak)

    def test_external_symlink_is_reported_without_reading_target(self):
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "private.txt"
            target.write_text(self.key, encoding="utf-8")
            link = self.root / "linked.txt"
            link.symlink_to(target)
            self.stage("linked.txt")
            original = Path.read_bytes

            def guarded_read(path):
                if path == link or path == target:
                    self.fail("external symlink target was read")
                return original(path)

            with mock.patch.object(Path, "read_bytes", guarded_read):
                findings = check_secrets.check_repository(self.root)
            self.assertTrue(findings)
            self.assertTrue(all("outside the repository" in finding for _, finding in findings))

    def test_internal_symlink_target_is_scanned(self):
        self.write(".gitignore", "private.txt\n")
        self.write("private.txt", self.key)
        (self.root / "public.txt").symlink_to("private.txt")
        self.assertTrue(check_secrets.check_repository(self.root))

    def test_credential_in_filename_is_redacted(self):
        self.write(self.key + ".txt", self.key)
        self.assertNotIn(self.key, str(check_secrets.check_repository(self.root)))

    def test_command_uses_script_root_and_redacts_failures(self):
        script = self.root / "scripts" / "check_secrets.py"
        script.parent.mkdir()
        shutil.copyfile(Path(check_secrets.__file__), script)
        self.write("leak.txt", self.key)
        nested = self.root / "other" / "nested"
        nested.mkdir(parents=True)
        result = subprocess.run([sys.executable, str(script)], cwd=nested,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("check_secrets: FAILED", result.stderr)
        self.assertIn("leak.txt", result.stderr)
        self.assertNotIn(self.key, result.stdout + result.stderr)

    def test_main_success_returns_zero(self):
        output = io.StringIO()
        with mock.patch.object(sys, "argv", ["check_secrets.py", "--root", str(self.root)]):
            with redirect_stdout(output):
                code = check_secrets.main()
        self.assertEqual(code, 0)
        self.assertIn("check_secrets: ok", output.getvalue())

    def test_main_repository_error_returns_two_without_exception_details(self):
        output = io.StringIO()
        with mock.patch.object(sys, "argv", ["check_secrets.py", "--root", str(self.root)]):
            with mock.patch.object(check_secrets, "check_repository", side_effect=OSError(self.key)):
                with redirect_stderr(output):
                    code = check_secrets.main()
        self.assertEqual(code, 2)
        self.assertIn("could not inspect", output.getvalue())
        self.assertNotIn(self.key, output.getvalue())


if __name__ == "__main__":
    unittest.main()
