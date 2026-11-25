"""The refresh workflow's storing step, run for real: bash executes it with a stand-in `gh`."""

import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "instagram-token-refresh.yml"
STEP = "Store a token that Instagram replaced"
TOKEN = "IGsynthetic_new_token_for_tests_0123456789"
REPOSITORY = "henryoier/calblue-website"


def step(text, name):
    parts = re.split(r"(?m)^      - name: (.+)$", text)
    bodies = {parts[index].strip(): parts[index + 1] for index in range(1, len(parts), 2)}
    return bodies[name]


def script(body):
    """The lines under `run: |`, as the runner would hand them to bash."""
    lines = body.splitlines()
    start = next(index for index, line in enumerate(lines) if line.strip() == "run: |")
    block = []
    for line in lines[start + 1:]:
        if line.strip() and not line.startswith(" " * 10):
            break
        block.append(line)
    return textwrap.dedent("\n".join(block)) + "\n"


@unittest.skipUnless(shutil.which("bash"), "needs bash")
class StoringStepTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.body = step(cls.text, STEP)
        cls.script = script(cls.body)

    def run_step(self, write_token, gh_exit=0):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        (root / "bin").mkdir()
        (root / "temp").mkdir()
        gh = root / "bin" / "gh"
        gh.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > "$GH_RECORD.args"\ncat > "$GH_RECORD.stdin"\n'
                      'printf "%s" "$GH_TOKEN" > "$GH_RECORD.token"\nexit "$GH_EXIT"\n', encoding="utf-8")
        gh.chmod(0o755)
        token_file = root / "temp" / "instagram-token"
        token_file.write_text(TOKEN, encoding="utf-8")
        (root / "step.sh").write_text(self.script, encoding="utf-8")
        env = {"PATH": f"{root / 'bin'}:{os.environ['PATH']}", "RUNNER_TEMP": str(root / "temp"),
               "GITHUB_REPOSITORY": REPOSITORY, "GH_TOKEN": write_token,
               "GH_RECORD": str(root / "gh"), "GH_EXIT": str(gh_exit)}
        done = subprocess.run(["bash", "-e", str(root / "step.sh")], capture_output=True, text=True, env=env, timeout=30)
        record = {name: (root / f"gh.{name}").read_text() if (root / f"gh.{name}").exists() else None
                  for name in ("args", "stdin", "token")}
        return done, token_file, record

    def test_without_a_write_token_the_step_succeeds_with_a_notice_and_stores_nothing(self):
        done, token_file, record = self.run_step(write_token="")
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = done.stdout.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("::notice::Instagram answered with a different token string. It was not stored"))
        self.assertIn("the stored token stays in use", lines[0])
        self.assertIn("not a failure", lines[0])
        self.assertNotIn("::error::", done.stdout + done.stderr)
        self.assertEqual(record["args"], None, "gh must not be called without a write token")
        self.assertFalse(token_file.exists(), "the new token must not be left on disk")
        self.assertNotIn(TOKEN, done.stdout + done.stderr)

    def test_with_a_write_token_the_new_string_goes_into_the_secret(self):
        done, token_file, record = self.run_step(write_token="synthetic-write-token")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(record["args"], f"secret set IG_ACCESS_TOKEN --repo {REPOSITORY}\n")
        self.assertEqual(record["stdin"], TOKEN)
        self.assertEqual(record["token"], "synthetic-write-token")
        self.assertEqual(done.stdout, "::notice::The token string Instagram issued is now stored in the IG_ACCESS_TOKEN secret.\n")
        self.assertFalse(token_file.exists())
        self.assertNotIn(TOKEN, done.stdout + done.stderr)

    def test_a_secret_that_could_not_be_written_fails_the_step_and_still_cleans_up(self):
        done, token_file, record = self.run_step(write_token="synthetic-write-token", gh_exit=1)
        self.assertNotEqual(done.returncode, 0)
        self.assertNotIn("is now stored", done.stdout)
        self.assertFalse(token_file.exists())
        self.assertNotIn(TOKEN, done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main()
