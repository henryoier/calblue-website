"""Regression tests for the no-package JavaScript runner's runtime dispatch."""

import importlib.util
import io
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("run_js_tests", ROOT / "scripts/run_js_tests.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class RuntimeTests(unittest.TestCase):
    def test_stripping_imports_does_not_remove_similarly_named_variables(self):
        source = 'import { value } from "./value.js";\nimports += 1;\nimportant();\n'
        stripped = RUNNER.strip_modules(source)
        self.assertNotIn('from "./value.js"', stripped)
        self.assertIn("imports += 1;", stripped)
        self.assertIn("important();", stripped)

    def test_prefers_existing_node(self):
        with patch.object(RUNNER.shutil, "which", side_effect=lambda name: "/bin/" + name):
            self.assertEqual(RUNNER.select_runtime(), ("node", "/bin/node"))

    def test_uses_macos_fallback(self):
        with patch.object(RUNNER.shutil, "which", side_effect=[None, "/usr/bin/osascript"]):
            self.assertEqual(RUNNER.select_runtime(), ("osascript", "/usr/bin/osascript"))

    def test_missing_runtime_fails_with_instructions(self):
        output = io.StringIO()
        with patch.object(RUNNER.shutil, "which", return_value=None), redirect_stdout(output):
            self.assertEqual(RUNNER.main(), 1)
        self.assertIn("no JavaScript runtime found", output.getvalue())

    def test_node_emits_json_to_stdout(self):
        completed = subprocess.CompletedProcess([], 0, stdout='[{"name":"ok","failures":[]}]')
        with patch.object(RUNNER.subprocess, "run", return_value=completed) as run:
            results, error = RUNNER.run_suite(*RUNNER.SUITES[0], ("node", "/bin/node"))
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ["/bin/node", "-e"])
        self.assertIn("process.stdout.write(JSON.stringify(__results))", command[-1])
        self.assertNotIn("export function", command[-1])
        self.assertIsNone(error)
        self.assertEqual(results[0]["name"], "ok")

    def test_osascript_uses_expression_result(self):
        completed = subprocess.CompletedProcess([], 0, stdout="[]")
        with patch.object(RUNNER.subprocess, "run", return_value=completed) as run:
            results, error = RUNNER.run_suite(*RUNNER.SUITES[0], ("osascript", "/usr/bin/osascript"))
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/usr/bin/osascript", "-l", "JavaScript", "-e"])
        self.assertTrue(command[-1].endswith("JSON.stringify(__results);"))
        self.assertNotIn("process.stdout", command[-1])
        self.assertEqual(results, [])
        self.assertIsNone(error)

    def test_runtime_error_is_reported(self):
        completed = subprocess.CompletedProcess([], 1, stdout="", stderr="syntax error")
        with patch.object(RUNNER.subprocess, "run", return_value=completed):
            results, error = RUNNER.run_suite(*RUNNER.SUITES[0], ("node", "/bin/node"))
        self.assertIsNone(results)
        self.assertEqual(error, "syntax error")

    def test_invalid_json_is_reported(self):
        completed = subprocess.CompletedProcess([], 0, stdout="not json")
        with patch.object(RUNNER.subprocess, "run", return_value=completed):
            results, error = RUNNER.run_suite(*RUNNER.SUITES[0], ("node", "/bin/node"))
        self.assertIsNone(results)
        self.assertIn("unparseable output", error)


if __name__ == "__main__":
    unittest.main()
