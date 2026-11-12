"""The Instagram token refresh extends the token, fails loudly when refused, and never prints it."""

from datetime import datetime, timezone
import importlib.util
import io
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("refresh_instagram_token", ROOT / "scripts" / "refresh_instagram_token.py")
RT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RT)

OLD = "IGAAoldTOKEN123"
NEW = "IGAAnewTOKEN456"
NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
SIXTY_DAYS = 5183944          # what Instagram answers: just under 60 days


def answer(token=OLD, lifetime=SIXTY_DAYS):
    return lambda url: {"access_token": token, "token_type": "bearer", "expires_in": lifetime}


class RefreshTests(unittest.TestCase):
    def test_calls_the_refresh_endpoint_with_the_token(self):
        seen = []
        page = RT.refresh(OLD, fetch=lambda url: seen.append(url) or answer()(url))
        self.assertEqual(seen, [f"https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token={OLD}"])
        self.assertEqual(page, {"access_token": OLD, "expires_in": SIXTY_DAYS})

    def test_token_is_url_encoded(self):
        seen = []
        RT.refresh('a"b&c d', fetch=lambda url: seen.append(url) or answer()(url))
        self.assertTrue(seen[0].endswith("access_token=a%22b%26c%20d"))

    def test_instagrams_explanation_is_kept(self):
        refused = {"error": {"message": "Error validating access token: Session has expired", "type": "OAuthException", "code": 190}}
        with self.assertRaises(RT.RefreshError) as caught:
            RT.refresh(OLD, fetch=lambda url: refused)
        self.assertEqual(str(caught.exception), "Error validating access token: Session has expired (code 190)")

    def test_answers_without_a_token_or_lifetime_are_errors(self):
        for page in ({}, {"access_token": OLD}, {"access_token": OLD, "expires_in": 0}, {"access_token": "", "expires_in": 5}, {"access_token": OLD, "expires_in": True}, ["x"]):
            with self.subTest(page=page), self.assertRaises(RT.RefreshError):
                RT.refresh(OLD, fetch=lambda url, page=page: page)


class FetchTests(unittest.TestCase):
    def test_the_url_reaches_curl_on_stdin_never_in_argv(self):
        completed = mock.Mock(returncode=0, stdout=b'{"ok": true}', stderr=b"")
        with mock.patch.object(RT.subprocess, "run", return_value=completed) as run:
            self.assertEqual(RT.fetch_json(f"https://graph.example/x?access_token={OLD}"), {"ok": True})
        argv = run.call_args.args[0]
        self.assertFalse(any(OLD in part for part in argv))
        self.assertNotIn("--fail", argv)
        self.assertEqual(run.call_args.kwargs["input"], f'url = "https://graph.example/x?access_token={OLD}"\n'.encode())

    def test_transport_failures_and_non_json_are_refresh_errors(self):
        failed = mock.Mock(returncode=6, stdout=b"", stderr=b"curl: (6) Could not resolve host")
        with mock.patch.object(RT.subprocess, "run", return_value=failed), self.assertRaises(RT.RefreshError):
            RT.fetch_json("https://graph.example/x")
        html = mock.Mock(returncode=0, stdout=b"<html>", stderr=b"")
        with mock.patch.object(RT.subprocess, "run", return_value=html), self.assertRaises(RT.RefreshError):
            RT.fetch_json("https://graph.example/x")


class MainTests(unittest.TestCase):
    def run_main(self, fetch, env=None, argv=()):
        out = io.StringIO()
        env = {"IG_ACCESS_TOKEN": OLD} if env is None else env
        code = RT.main(list(argv), env=env, fetch=fetch, now=NOW, out=out)
        return code, out.getvalue()

    def test_unchanged_token_reports_the_new_expiry(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "token"
            code, text = self.run_main(answer(), argv=["--new-token-file", str(target)])
            self.assertFalse(target.exists())
        self.assertEqual(code, 0)
        self.assertEqual(text, "refresh_instagram_token: Instagram token extended: valid for 60 days, until 2027-01-11.\n")

    def test_missing_token_fails(self):
        code, text = self.run_main(answer(), env={"IG_ACCESS_TOKEN": "  "})
        self.assertEqual(code, 1)
        self.assertIn("IG_ACCESS_TOKEN is not set", text)

    def test_a_refused_refresh_fails_with_the_reason_and_the_next_step(self):
        refused = {"error": {"message": f"Error validating access token {OLD}: The user has not authorized application 1.", "code": 190}}
        code, text = self.run_main(lambda url: refused)
        self.assertEqual(code, 1)
        self.assertIn("The user has not authorized application 1. (code 190)", text)
        self.assertIn("paste it into the IG_ACCESS_TOKEN repository secret", text)
        self.assertNotIn(OLD, text)

    def test_a_transport_error_that_echoes_the_url_is_redacted(self):
        def broken(url):
            raise RT.RefreshError(f"curl exited 3: bad URL {url}")
        code, text = self.run_main(broken)
        self.assertEqual(code, 1)
        self.assertNotIn(OLD, text)
        self.assertIn("access_token=[token]", text)

    def test_a_replaced_token_is_written_for_the_workflow_and_never_printed(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "nested" / "token"
            code, text = self.run_main(answer(NEW), argv=["--new-token-file", str(target)])
            self.assertEqual(target.read_text(), NEW)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(code, 0)
        self.assertIn("Instagram issued a different token string", text)
        self.assertNotIn(OLD, text)
        self.assertNotIn(NEW, text)

    def test_in_actions_a_replaced_token_is_masked_first_and_reported_as_an_output(self):
        with tempfile.TemporaryDirectory() as folder:
            outputs = Path(folder) / "outputs"
            env = {"IG_ACCESS_TOKEN": OLD, "GITHUB_ACTIONS": "true", "GITHUB_OUTPUT": str(outputs)}
            code, text = self.run_main(answer(NEW), env=env, argv=["--new-token-file", str(Path(folder) / "token")])
            self.assertEqual(outputs.read_text(), "changed=true\nexpires_at=2027-01-11\n")
        self.assertEqual(code, 0)
        lines = text.splitlines()
        self.assertEqual(lines[0], f"::add-mask::{NEW}")
        self.assertTrue(lines[1].startswith("::notice::Instagram token extended"))
        self.assertNotIn(NEW, "\n".join(lines[1:]))
        self.assertNotIn(OLD, text)

    def test_in_actions_an_unchanged_token_sets_changed_false(self):
        with tempfile.TemporaryDirectory() as folder:
            outputs = Path(folder) / "outputs"
            env = {"IG_ACCESS_TOKEN": OLD, "GITHUB_ACTIONS": "true", "GITHUB_OUTPUT": str(outputs)}
            code, text = self.run_main(answer(), env=env)
            self.assertEqual(outputs.read_text(), "changed=false\nexpires_at=2027-01-11\n")
        self.assertEqual((code, text), (0, "::notice::Instagram token extended: valid for 60 days, until 2027-01-11.\n"))

    def test_a_token_that_was_not_really_extended_fails(self):
        code, text = self.run_main(answer(lifetime=3 * 86400))
        self.assertEqual(code, 1)
        self.assertIn("lasts only 3 days", text)


class WorkflowTests(unittest.TestCase):
    """Offline contract for the scheduled workflow; not a general YAML parser."""

    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / ".github/workflows/instagram-token-refresh.yml").read_text()

    def test_runs_twice_a_week_and_on_demand(self):
        events = self.workflow.split("on:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertEqual(re.findall(r"^  ([a-z_]+):", events, re.M), ["schedule", "workflow_dispatch"])
        self.assertEqual(re.findall(r"cron: '([^']+)'", events), ["23 16 * * 0,3"])

    def test_job_is_read_only_bounded_and_excludes_forks(self):
        permissions = self.workflow.split("permissions:\n", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertEqual(permissions.strip(), "contents: read")
        self.assertIn("if: github.repository == 'henryoier/calblue-website'", self.workflow)
        self.assertIn("timeout-minutes: 5", self.workflow)
        self.assertIn("group: instagram-token-refresh", self.workflow)
        self.assertIn("cancel-in-progress: false", self.workflow)
        self.assertEqual(re.findall(r"^\s+uses: (.+)$", self.workflow, re.M), ["actions/checkout@v4"])
        self.assertIn("persist-credentials: false", self.workflow)

    def test_a_refused_token_fails_the_run(self):
        self.assertNotIn("continue-on-error:", self.workflow)
        self.assertNotIn("|| echo", self.workflow)
        self.assertNotIn("|| true", self.workflow)

    def test_the_token_reaches_the_script_through_the_environment_only(self):
        self.assertEqual(self.workflow.count("${{ secrets.IG_ACCESS_TOKEN }}"), 1)
        self.assertIn("          IG_ACCESS_TOKEN: ${{ secrets.IG_ACCESS_TOKEN }}\n", self.workflow)
        self.assertIn('run: python3 -B scripts/refresh_instagram_token.py --new-token-file "$RUNNER_TEMP/instagram-token"', self.workflow)
        self.assertNotIn("--token", self.workflow)

    def test_a_replaced_token_is_stored_only_with_a_dedicated_secret_and_the_file_is_removed(self):
        step = self.workflow.split("- name: Store a token that Instagram replaced", 1)[1]
        self.assertIn("if: steps.refresh.outputs.changed == 'true'", step)
        self.assertIn("GH_TOKEN: ${{ secrets.SECRETS_WRITE_TOKEN }}", step)
        self.assertIn('gh secret set IG_ACCESS_TOKEN --repo "$GITHUB_REPOSITORY" < "$RUNNER_TEMP/instagram-token"', step)
        self.assertEqual(step.count('rm -f "$RUNNER_TEMP/instagram-token"'), 2)
        self.assertIn("exit 1", step)


if __name__ == "__main__":
    unittest.main()
