"""The headless-browser runner, tested without a browser: a stand-in executable plays Chrome."""

import html
import io
import sys
import tempfile
import textwrap
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from scripts.run_browser_tests import (
    browser_command, find_browser, judge, main, read_report, serve,
)


ROOT = Path(__file__).resolve().parents[1]


def page(title, tests, stray=""):
    """A finished test page as app/tests/runner.js renders it. tests: [(name, passed, detail)]."""
    failed = sum(1 for _, passed, _ in tests if not passed)
    items = "".join(
        f'<li class="{"ok" if passed else "bad"}">{"PASS" if passed else "FAIL"} — {html.escape(name)}'
        f"<pre>{html.escape(detail)}</pre></li>" for name, passed, detail in tests)
    summary = f"{failed} of {len(tests)} failed" if failed else f"all {len(tests)} passed"
    return (f"<html><head><title>{html.escape(title)}</title></head><body><h1>CalBlue app tests</h1>{stray}"
            f'<div id="out"><p class="summary {"bad" if failed else "ok"}">{summary}</p><ul>{items}</ul></div>'
            "</body></html>")


PASSING = page("PASS 2/2", [("router keeps the hash", True, ""), ("dom escapes <b> & quotes", True, "")])
FAILING = page("FAIL 1/3", [
    ("router keeps the hash", True, ""),
    ("layout hides admin links", False, "\n      not equal\n      expected: 2\n      actual:   3"),
    ("dom escapes text", True, ""),
])


def stand_in_browser(directory, dom, code=0, stderr="", delay=0):
    """An executable that behaves like `chrome --dump-dom URL`: fetches the page, prints `dom`."""
    script = Path(directory) / "stand_in_browser.py"
    script.write_text(textwrap.dedent(f"""
        import sys, time, urllib.request
        if "--version" in sys.argv:
            print("Stand-in Browser 1.0")
            sys.exit(0)
        url = sys.argv[-1]
        served = urllib.request.urlopen(url, timeout=10).read().decode("utf-8")
        assert "CalBlue app tests" in served, "the local server did not serve the test page"
        urllib.request.urlopen(url + "runner.js", timeout=10).read()
        time.sleep({delay!r})
        sys.stderr.write({stderr!r})
        sys.stdout.write({dom!r})
        sys.exit({code!r})
    """), encoding="utf-8")
    launcher = Path(directory) / "stand-in-browser"
    launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
    launcher.chmod(0o755)
    return str(launcher)


def run(*arguments):
    out = io.StringIO()
    return main(list(arguments), out=out), out.getvalue()


class ReadReportTests(unittest.TestCase):
    def test_a_passing_page_is_read_with_every_test(self):
        report = read_report(PASSING)
        self.assertEqual((report["verdict"], report["count"], report["total"]), ("PASS", 2, 2))
        self.assertEqual([test["name"] for test in report["tests"]],
                         ["router keeps the hash", "dom escapes <b> & quotes"])
        self.assertEqual(judge(report), [])

    def test_a_failing_page_names_the_test_and_its_details(self):
        report = read_report(FAILING)
        self.assertEqual((report["verdict"], report["count"], report["total"]), ("FAIL", 1, 3))
        problems = judge(report)
        self.assertEqual(problems[0], "FAIL  layout hides admin links")
        self.assertIn("        expected: 2", problems)
        self.assertIn("        actual:   3", problems)
        self.assertEqual(len(problems), 4)

    def test_a_page_that_never_reported_is_not_a_pass(self):
        unfinished = "<html><head><title>CalBlue app tests</title></head><body><div id=\"out\">running…</div></body></html>"
        self.assertEqual(judge(read_report(unfinished)), ["the page did not finish: its title is still 'CalBlue app tests'"])
        self.assertEqual(judge(read_report("")), ["the browser returned no page"])

    def test_a_module_that_could_not_load_is_reported_as_such(self):
        broken = "<title>FAIL — test modules could not load</title><div id=\"out\">FAIL: missing</div>"
        self.assertEqual(judge(read_report(broken)),
                         ["the page could not load its test modules (title: FAIL — test modules could not load)"])

    def test_a_title_that_disagrees_with_the_list_is_refused(self):
        two_listed = page("PASS 3/3", [("a", True, ""), ("b", True, "")])
        self.assertIn("the report is inconsistent", judge(read_report(two_listed))[0])
        hidden_failure = page("PASS 2/2", [("a", True, ""), ("b", False, "boom")])
        self.assertIn("the report is inconsistent", judge(read_report(hidden_failure))[0])
        impossible = page("PASS 3/2", [("a", True, ""), ("b", True, "")])
        self.assertIn("the report is inconsistent", judge(read_report(impossible))[0])

    def test_a_page_that_lost_its_suites_cannot_pass(self):
        self.assertEqual(judge(read_report(page("PASS 0/0", []))), ["only 0 tests ran; at least 1 are expected"])
        self.assertEqual(judge(read_report(PASSING), min_tests=3), ["only 2 tests ran; at least 3 are expected"])
        self.assertEqual(judge(read_report(PASSING), min_tests=2), [])

    def test_list_items_outside_the_report_are_not_results(self):
        fixture = '<ul><li class="ok">PASS — a fixture a test rendered</li><li class="bad">FAIL — another</li></ul>'
        report = read_report(page("PASS 2/2", [("a", True, ""), ("b", True, "")], stray=fixture))
        self.assertEqual([test["name"] for test in report["tests"]], ["a", "b"])
        self.assertEqual(judge(report), [])


class BrowserChoiceTests(unittest.TestCase):
    def test_order_is_flag_then_environment_then_path_then_mac_apps(self):
        files = {"/opt/chrome", "/env/chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"}
        on_path = {"chromium": "/usr/bin/chromium", "my-chrome": "/usr/local/bin/my-chrome"}
        find = lambda explicit=None, env=None: find_browser(
            explicit, env or {}, which=on_path.get, is_file=files.__contains__)
        self.assertEqual(find("/opt/chrome", {"CHROME_BIN": "/env/chrome"}), "/opt/chrome")
        self.assertEqual(find("my-chrome"), "/usr/local/bin/my-chrome")
        self.assertIsNone(find("/missing/chrome", {"CHROME_BIN": "/env/chrome"}))     # an explicit choice is final
        self.assertEqual(find(env={"CHROME_BIN": "/env/chrome"}), "/env/chrome")
        self.assertEqual(find(env={"CHROME": "/env/chrome"}), "/env/chrome")
        self.assertEqual(find(), "/usr/bin/chromium")
        on_path.clear()
        self.assertEqual(find(), "/Applications/Chromium.app/Contents/MacOS/Chromium")
        files.clear()
        self.assertIsNone(find())

    def test_command_dumps_the_dom_headless_and_sandbox_is_dropped_only_on_request(self):
        command = browser_command("/opt/chrome", "http://127.0.0.1:9/app/tests/", "/tmp/profile")
        self.assertEqual(command[0], "/opt/chrome")
        self.assertEqual(command[-1], "http://127.0.0.1:9/app/tests/")
        for flag in ("--headless=new", "--dump-dom", "--user-data-dir=/tmp/profile", "--virtual-time-budget=600000"):
            self.assertIn(flag, command)
        self.assertNotIn("--no-sandbox", command)
        self.assertIn("--no-sandbox", browser_command("/opt/chrome", "http://x/", "/tmp/p", no_sandbox=True))


class LocalServerTests(unittest.TestCase):
    def test_serves_modules_as_javascript_and_records_what_was_missing(self):
        with serve(ROOT) as (server, base):
            self.assertTrue(base.startswith("http://127.0.0.1:"))
            with urllib.request.urlopen(base + "app/tests/runner.js", timeout=10) as response:
                self.assertEqual(response.headers.get_content_type(), "text/javascript")
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertIn(b"export function test", response.read())
            with self.assertRaises(urllib.error.HTTPError) as missing:
                urllib.request.urlopen(base + "app/tests/no-such-module.js", timeout=10)
            self.assertEqual(missing.exception.code, 404)
            self.assertEqual(server.misses, ["404 /app/tests/no-such-module.js"])
        with self.assertRaises(urllib.error.URLError):          # the port is closed again afterwards
            urllib.request.urlopen(base + "app/tests/runner.js", timeout=3)


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def browser(self, dom, **options):
        return stand_in_browser(self.directory.name, dom, **options)

    def test_a_passing_page_exits_zero_and_lists_the_tests(self):
        code, text = run("--browser", self.browser(PASSING))
        self.assertEqual(code, 0, text)
        self.assertIn("  pass  router keeps the hash", text)
        self.assertIn("run_browser_tests: ok — 2/2 passed (Stand-in Browser 1.0, headless)", text)

    def test_a_failing_page_exits_non_zero_with_the_failure(self):
        code, text = run("--browser", self.browser(FAILING), "--quiet")
        self.assertEqual(code, 1)
        self.assertIn("run_browser_tests: FAILED (Stand-in Browser 1.0)", text)
        self.assertIn("  FAIL  layout hides admin links", text)
        self.assertIn("expected: 2", text)
        self.assertNotIn("pass  router keeps the hash", text)        # --quiet lists failures only

    def test_too_few_tests_fail_the_run(self):
        code, text = run("--browser", self.browser(PASSING), "--min-tests", "250")
        self.assertEqual(code, 1)
        self.assertIn("only 2 tests ran; at least 250 are expected", text)

    def test_a_browser_that_prints_nothing_fails_with_its_error(self):
        code, text = run("--browser", self.browser("", code=133, stderr="FATAL: could not register\n"))
        self.assertEqual(code, 1)
        self.assertIn("the browser returned no page", text)
        self.assertIn("browser exit code 133", text)
        self.assertIn("FATAL: could not register", text)

    def test_a_browser_that_hangs_is_stopped(self):
        started = time.monotonic()
        code, text = run("--browser", self.browser(PASSING, delay=20), "--timeout", "1")
        self.assertEqual(code, 1)
        self.assertIn("the browser did not finish within 1 s", text)
        self.assertLess(time.monotonic() - started, 15)

    def test_no_browser_is_a_failure_not_a_skip(self):
        code, text = run("--browser", str(Path(self.directory.name) / "missing-browser"))
        self.assertEqual(code, 1)
        self.assertIn("no Chrome or Chromium found", text)

    def test_a_missing_page_fails_and_names_the_missing_file(self):
        empty_root = Path(self.directory.name) / "empty"
        empty_root.mkdir()
        script = Path(self.directory.name) / "blind.py"
        script.write_text(textwrap.dedent("""
            import sys, urllib.request, urllib.error
            if "--version" in sys.argv:
                print("Stand-in Browser 1.0"); sys.exit(0)
            try:
                urllib.request.urlopen(sys.argv[-1], timeout=10)
            except urllib.error.HTTPError as error:
                sys.stdout.write("<html><head><title>Error response</title></head><body>%d</body></html>" % error.code)
        """), encoding="utf-8")
        launcher = Path(self.directory.name) / "blind-browser"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        launcher.chmod(0o755)
        code, text = run("--browser", str(launcher), "--root", str(empty_root))
        self.assertEqual(code, 1)
        self.assertIn("the page did not finish: its title is still 'Error response'", text)
        self.assertIn("the page asked for a file that was not served: 404 /app/tests/", text)


if __name__ == "__main__":
    unittest.main()
