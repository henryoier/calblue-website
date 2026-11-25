#!/usr/bin/env python3
"""Run the browser test page in headless Chrome and report what it says.

    python3 scripts/run_browser_tests.py [--browser PATH] [--no-sandbox] [--min-tests N] [--quiet]

`app/tests/` holds the suites that need a real browser: DOM parsing, native ES modules and routing
on the real `location`. The page runs them all, then sets `document.title` to `PASS n/n` or
`FAIL k/n` and lists every test (see `app/tests/runner.js`). This script serves the repository on a
local port, opens that page in an installed Chrome or Chromium without a window, reads the finished
page and exits non-zero unless every test passed.

Nothing is installed: Python's standard library and a browser that is already on the machine. The
suites use injected doubles, so the page requests nothing but the repository's own files.
"""

import argparse
import contextlib
import functools
import html
import http.server
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = "app/tests/"
BROWSER_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
                 "microsoft-edge")
MAC_BROWSERS = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
)
TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
VERDICT = re.compile(r"^(PASS|FAIL) (\d+)/(\d+)$")


def find_browser(explicit=None, env=None, which=shutil.which, is_file=os.path.isfile):
    """The browser to drive: --browser, else $CHROME_BIN or $CHROME, else one on PATH, else a macOS app."""
    env = os.environ if env is None else env
    wanted = [explicit] if explicit else [env.get("CHROME_BIN"), env.get("CHROME"), *BROWSER_NAMES, *MAC_BROWSERS]
    for candidate in wanted:
        if not candidate:
            continue
        if is_file(candidate):
            return candidate
        found = which(candidate)
        if found:
            return found
    return None


class Report(HTMLParser):
    """The list the page rendered into #out: <li class="ok|bad">PASS — name<pre>details</pre></li>."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tests = []
        self._depth = 0           # > 0 while inside <div id="out">; fixtures elsewhere are not results
        self._item = None
        self._in_detail = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if not self._depth:
            if tag == "div" and attributes.get("id") == "out":
                self._depth = 1
            return
        classes = (attributes.get("class") or "").split()
        if tag == "div":
            self._depth += 1
        elif tag == "li" and ("ok" in classes or "bad" in classes):
            self._item = {"ok": "bad" not in classes, "name": "", "detail": ""}
        elif tag == "pre" and self._item is not None:
            self._in_detail = True

    def handle_endtag(self, tag):
        if not self._depth:
            return
        if tag == "div":
            self._depth -= 1
        elif tag == "pre":
            self._in_detail = False
        elif tag == "li" and self._item is not None:
            self._item["name"] = re.sub(r"^(PASS|FAIL) — ", "", self._item["name"].strip())
            self._item["detail"] = self._item["detail"].strip()
            self.tests.append(self._item)
            self._item = None

    def handle_data(self, data):
        if self._depth and self._item is not None:
            self._item["detail" if self._in_detail else "name"] += data


def read_report(dom):
    """What the finished page says. `verdict` is None when the page never reached its report."""
    match = TITLE.search(dom or "")
    title = html.unescape(match.group(1)).strip() if match else ""
    parser = Report()
    parser.feed(dom or "")
    parser.close()
    verdict = VERDICT.match(title)
    return {
        "title": title,
        "verdict": verdict.group(1) if verdict else None,
        "count": int(verdict.group(2)) if verdict else None,      # passed for PASS, failed for FAIL
        "total": int(verdict.group(3)) if verdict else None,
        "tests": parser.tests,
    }


def judge(report, min_tests=1):
    """Why the run is not a pass, as lines of text. An empty list means every test passed."""
    title, tests = report["title"], report["tests"]
    if not title:
        return ["the browser returned no page"]
    if report["verdict"] is None:
        if title.startswith("FAIL"):
            return [f"the page could not load its test modules (title: {title})"]
        return [f"the page did not finish: its title is still {title!r}"]
    total = report["total"]
    failed = report["count"] if report["verdict"] == "FAIL" else total - report["count"]
    listed_failed = [test for test in tests if not test["ok"]]
    problems = []
    if failed < 0 or len(tests) != total or len(listed_failed) != failed:
        problems.append(f"the report is inconsistent: the title says {title!r}, the list has {len(tests)} "
                        f"tests and {len(listed_failed)} failures")
    floor = max(1, min_tests)
    if total < floor:
        problems.append(f"only {total} tests ran; at least {floor} are expected")
    for test in listed_failed:
        problems.append(f"FAIL  {test['name']}")
        problems.extend(f"        {line.strip()}" for line in test["detail"].splitlines() if line.strip())
    if failed > 0 and not listed_failed:
        problems.append(f"{failed} of {total} tests failed")
    return problems


class _Handler(http.server.SimpleHTTPRequestHandler):
    # Module scripts are refused unless they arrive with a JavaScript type; do not depend on the
    # machine's own type table for that.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript"}

    def log_message(self, format, *args):       # keep the test output readable
        pass

    def send_error(self, code, message=None, explain=None):
        self.server.misses.append(f"{int(code)} {self.path}")
        super().send_error(code, message, explain)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


@contextlib.contextmanager
def serve(root):
    """Serve `root` on a free 127.0.0.1 port for the length of the block. Yields (server, base URL)."""
    handler = functools.partial(_Handler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.misses = []
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_address[1]}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def browser_command(browser, url, profile, virtual_ms=600000, no_sandbox=False):
    """Print the page's DOM once its timers and requests have settled (virtual time, so no real wait)."""
    command = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               "--disable-extensions", "--disable-background-networking", "--disable-sync", "--mute-audio",
               f"--user-data-dir={profile}", f"--virtual-time-budget={virtual_ms}", "--dump-dom"]
    if no_sandbox:
        command.insert(1, "--no-sandbox")
    return command + [url]


def browser_version(browser):
    try:
        done = subprocess.run([browser, "--version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return "unknown version"
    lines = done.stdout.strip().splitlines()
    return lines[0].strip() if lines else "unknown version"


def main(argv=None, out=None):
    out = sys.stdout if out is None else out
    parser = argparse.ArgumentParser(description="Run app/tests/ in headless Chrome and report the result.")
    parser.add_argument("--browser", help="Chrome or Chromium executable (default: $CHROME_BIN, PATH, macOS apps)")
    parser.add_argument("--root", default=str(ROOT), help="directory to serve (default: the repository)")
    parser.add_argument("--page", default=PAGE, help=f"test page under the root (default: {PAGE})")
    parser.add_argument("--min-tests", type=int, default=1,
                        help="fail when fewer tests ran than this, so a page that silently lost its suites "
                             "cannot pass (default: 1)")
    parser.add_argument("--timeout", type=float, default=180, help="seconds to wait for the browser (default: 180)")
    parser.add_argument("--no-sandbox", action="store_true",
                        help="pass --no-sandbox to the browser; CI containers and runners that forbid "
                             "unprivileged user namespaces need it. The page is this repository's own.")
    parser.add_argument("--quiet", action="store_true", help="list only failing tests")
    args = parser.parse_args(argv)

    def say(line=""):
        print(line, file=out)

    browser = find_browser(args.browser)
    if not browser:
        say("run_browser_tests: FAILED — no Chrome or Chromium found. Install one, pass --browser PATH or set "
            "CHROME_BIN; or serve the repository and open app/tests/ in a browser.")
        return 1
    version = browser_version(browser)
    profile = tempfile.mkdtemp(prefix="calblue-browser-")
    try:
        with serve(args.root) as (server, base):
            command = browser_command(browser, base + args.page, profile, no_sandbox=args.no_sandbox)
            try:
                done = subprocess.run(command, capture_output=True, timeout=args.timeout)
            except subprocess.TimeoutExpired:
                say(f"run_browser_tests: FAILED — the browser did not finish within {args.timeout:g} s ({version})")
                return 1
            except OSError as error:
                say(f"run_browser_tests: FAILED — the browser could not be started: {error}")
                return 1
            misses = [miss for miss in server.misses if not miss.endswith("/favicon.ico")]
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    report = read_report(done.stdout.decode("utf-8", errors="replace"))
    problems = judge(report, args.min_tests)
    if not args.quiet:
        for test in report["tests"]:
            say(f"  {'pass' if test['ok'] else 'FAIL'}  {test['name']}")
        say()
    if problems:
        say(f"run_browser_tests: FAILED ({version})")
        for line in problems:
            say(f"  {line}")
        if not report["title"]:
            errors = done.stderr.decode("utf-8", errors="replace").strip().splitlines()[-3:]
            say(f"  browser exit code {done.returncode}" + "".join(f"\n  {line[:300]}" for line in errors))
        for miss in misses:
            say(f"  the page asked for a file that was not served: {miss}")
        return 1
    say(f"run_browser_tests: ok — {report['total']}/{report['total']} passed ({version}, headless)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
