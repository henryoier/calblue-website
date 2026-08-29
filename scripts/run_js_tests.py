#!/usr/bin/env python3
"""Run the pure-logic JavaScript tests on the command line.

    python3 scripts/run_js_tests.py

There is no node, deno or bun on this machine (ADR 0001), and headless Chrome cannot start from this
process tree — it dies on a Mach bootstrap permission error. What *is* available is JavaScriptCore,
via `osascript -l JavaScript`, and that is a real engine: Symbol, tagged templates, rest/spread and
arrow functions all work.

So the suites are split. Anything that is pure string logic — which is all of the escaping, and
therefore all of the security-relevant behaviour — lives in `app/tests/*.logic.js` and runs here,
for real, in CI. Anything needing a DOM lives in `app/tests/*.test.js` and runs only in a browser
at `app/tests/`.

JavaScriptCore has no module loader, so this strips `import`/`export` and concatenates. That is a
harness detail, not a change to the code under test.
"""

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app"

# (module under test, logic suite, entry point that wires them together)
SUITES = [
    (APP / "js" / "dom.js", APP / "tests" / "dom.logic.js", "domLogicTests"),
    (APP / "js" / "router.js", APP / "tests" / "router.logic.js", "routerLogicTests"),
    (APP / "js" / "session.js", APP / "tests" / "session.logic.js", "sessionLogicTests"),
    (APP / "js" / "games.js", APP / "tests" / "games.logic.js", "gamesLogicTests"),
    (APP / "js" / "public-roster.js", APP / "tests" / "public-roster.logic.js", "publicRosterLogicTests"),
    (APP / "js" / "auth.js", APP / "tests" / "auth.logic.js", "authLogicTests"),
    (APP / "js" / "identity.js", APP / "tests" / "identity.logic.js", "identityLogicTests"),
    (APP / "js" / "registration.js", APP / "tests" / "registration.logic.js", "registrationLogicTests"),
    (APP / "js" / "billing.js", APP / "tests" / "billing.logic.js", "billingLogicTests"),
]

HARNESS = """
var __results = [];
var __current = null;
var t = {
  test: function (name, fn) {
    __current = { name: name, failures: [] };
    __results.push(__current);
    try { fn(); }
    catch (e) { __current.failures.push("threw: " + (e && e.message ? e.message : String(e))); }
    __current = null;
  },
  assert: function (cond, msg) {
    if (!cond) __current.failures.push(msg || "assertion failed");
  },
  equal: function (actual, expected, msg) {
    if (actual !== expected) {
      __current.failures.push((msg || "not equal") +
        " | expected: " + JSON.stringify(expected) +
        " | actual: " + JSON.stringify(actual));
    }
  }
};
"""


def strip_modules(source):
    """JavaScriptCore has no module loader: drop import lines and the `export ` keyword."""
    source = re.sub(r"^\s*import[^;]*;\s*$", "", source, flags=re.MULTILINE)
    source = re.sub(r"^export\s+", "", source, flags=re.MULTILINE)
    return source


def run_suite(module_path, logic_path, entry):
    module_src = strip_modules(module_path.read_text())
    logic_src = strip_modules(logic_path.read_text())

    # The suite takes the module's exports as an object; rebuild one from the stripped globals.
    exported = re.findall(r"^export\s+function\s+(\w+)", module_path.read_text(), re.MULTILINE)
    bindings = ", ".join(f"{name}: {name}" for name in exported)

    script = "\n".join([
        module_src, logic_src, HARNESS,
        f"{entry}({{ {bindings} }}, t);",
        "JSON.stringify(__results);",
    ])

    proc = subprocess.run(["osascript", "-l", "JavaScript", "-e", script],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return None, proc.stderr.strip()
    import json
    try:
        return json.loads(proc.stdout.strip()), None
    except json.JSONDecodeError:
        return None, f"unparseable output: {proc.stdout[:300]}"


def main():
    total = failed = 0
    for module_path, logic_path, entry in SUITES:
        rel = module_path.relative_to(ROOT)
        results, error = run_suite(module_path, logic_path, entry)
        if error:
            print(f"run_js_tests: FAILED to execute {rel}\n  {error}")
            return 1
        print(f"\n{rel}  ({len(results)} tests)")
        for r in results:
            total += 1
            if r["failures"]:
                failed += 1
                print(f"  FAIL  {r['name']}")
                for f in r["failures"]:
                    print(f"          {f}")
            else:
                print(f"  pass  {r['name']}")

    print()
    if failed:
        print(f"run_js_tests: FAILED — {failed} of {total} tests failed")
        return 1
    print(f"run_js_tests: ok — {total}/{total} passed (JavaScriptCore via osascript)")
    print("note: DOM-dependent tests are browser-only; open app/tests/ to run those.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
