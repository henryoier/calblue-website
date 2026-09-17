#!/usr/bin/env python3
"""Run the pure-logic JavaScript tests on the command line.

    python3 scripts/run_js_tests.py

Use an existing Node executable (including on Linux CI), or JavaScriptCore via
`osascript -l JavaScript` on macOS. No package manager or build step is needed.

The suites are split: pure string logic lives in `app/tests/*.logic.js` and runs here.
Anything needing a DOM, including security-relevant browser parsing, lives in
`app/tests/*.test.js` and runs separately in a browser at `app/tests/`.

JavaScriptCore has no module loader, so this strips `import`/`export` and concatenates. That is a
harness detail, not a change to the code under test.
"""

import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app"

# (module under test, logic suite, entry point that wires them together)
SUITES = [
    (APP / "js" / "dom.js", APP / "tests" / "dom.logic.js", "domLogicTests"),
    (APP / "js" / "router.js", APP / "tests" / "router.logic.js", "routerLogicTests"),
    (APP / "js" / "session.js", APP / "tests" / "session.logic.js", "sessionLogicTests"),
    (APP / "js" / "layout.js", APP / "tests" / "layout.logic.js", "layoutLogicTests"),
    (APP / "js" / "supabase.js", APP / "tests" / "supabase.logic.js", "supabaseLogicTests"),
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
    source = re.sub(r"^\s*import\s+[^;]*;\s*$", "", source, flags=re.MULTILINE)
    source = re.sub(r"^export\s+", "", source, flags=re.MULTILINE)
    return source


def select_runtime():
    """Prefer the runtime available on CI; retain the no-install macOS fallback."""
    for name in ("node", "osascript"):
        executable = shutil.which(name)
        if executable:
            return name, executable
    return None


def run_suite(module_path, logic_path, entry, runtime):
    module_src = strip_modules(module_path.read_text())
    logic_src = strip_modules(logic_path.read_text())

    # The suite takes the module's exports as an object; rebuild one from the stripped globals.
    exported = re.findall(r"^export\s+function\s+(\w+)", module_path.read_text(), re.MULTILINE)
    bindings = ", ".join(f"{name}: {name}" for name in exported)

    runtime_name, executable = runtime
    output = ("process.stdout.write(JSON.stringify(__results));" if runtime_name == "node"
              else "JSON.stringify(__results);")
    script = "\n".join([
        module_src, logic_src, HARNESS,
        f"{entry}({{ {bindings} }}, t);",
        output,
    ])

    command = ([executable, "-e", script] if runtime_name == "node"
               else [executable, "-l", "JavaScript", "-e", script])
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        return None, proc.stderr.strip()
    try:
        return json.loads(proc.stdout.strip()), None
    except json.JSONDecodeError:
        return None, f"unparseable output: {proc.stdout[:300]}"


def main():
    runtime = select_runtime()
    if runtime is None:
        print("run_js_tests: no JavaScript runtime found; use Node or macOS osascript, "
              "or open app/tests/ in a browser.")
        return 1
    total = failed = 0
    for module_path, logic_path, entry in SUITES:
        rel = module_path.relative_to(ROOT)
        results, error = run_suite(module_path, logic_path, entry, runtime)
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
    engine = "Node" if runtime[0] == "node" else "JavaScriptCore via osascript"
    print(f"run_js_tests: ok — {total}/{total} passed ({engine})")
    print("note: DOM-dependent tests are browser-only; open app/tests/ to run those.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
