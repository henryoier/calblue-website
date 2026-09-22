#!/usr/bin/env python3
"""Run DOM-free Auth/session/identity/verification doubles with an existing runtime.

macOS uses the JavaScriptCore diagnostic. CI uses its preinstalled Node runtime.
These are mocks, not browser modules, real Auth, SMTP or database verification.
"""

import json
import shutil
import subprocess
import sys

from run_js_tests import ROOT, strip_modules


SOURCES = [
    "app/js/session.js",
    "app/tests/session.logic.js",
    "app/tests/session.live.test.js",
    "app/js/supabase.js",
    "app/tests/supabase.logic.js",
    "app/tests/supabase.test.js",
    "app/js/auth.js",
    "app/tests/auth.logic.js",
    "app/tests/auth.test.js",
    "app/js/identity.js",
    "app/tests/identity.logic.js",
    "app/tests/identity.data.test.js",
    "app/js/verification.js",
    "app/tests/verification.logic.js",
    "app/tests/verification.data.test.js",
    "app/js/pickup.js",
    "app/tests/pickup.logic.js",
    "app/tests/pickup.data.test.js",
]

HARNESS = """
const tests = [];
let current;
function testAsync(name, fn) { tests.push({name, fn}); }
function test(name, fn) { testAsync(name, (t) => { current = t; fn(); }); }
function assert(condition, message) { current.assert(condition, message); }
function equal(actual, expected, message) { current.equal(actual, expected, message); }
const supabase = { configurationIsUsable, createClientProvider };
const auth = { safeReturnTo, allowedRedirectUrl, normalizeEmail, parseAuthCallback, createAuthFlow };
"""

RUN = """
const identity = { createIdentityService, validateIdentity, identityToday, IDENTITY_LIMITS };
identityLogicTests(identity, { test, assert, equal });
identityDataTests(identity, { testAsync });
const verification = { createVerificationService, validateVerificationSearch, validateVerificationDecision, VERIFICATION_LIMITS };
verificationLogicTests(verification, { test, assert, equal });
verificationDataTests(verification, { testAsync });
const pickup = { createPickupService, validatePickupDetails, pickupLocalInput, pickupLocalToInstant, PICKUP_LIMITS };
pickupLogicTests(pickup, { test, assert, equal });
pickupDataTests(pickup, { testAsync });
(async () => {
  const records = [];
  for (const item of tests) {
    const record = {name: item.name, failures: []};
    records.push(record);
    const t = {
      assert(value, message) { if (!value) record.failures.push(message || 'assertion failed'); },
      equal(actual, expected, message) {
        if (actual !== expected) record.failures.push((message || 'not equal')
          + ' | expected: ' + JSON.stringify(expected) + ' | actual: ' + JSON.stringify(actual));
      }
    };
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => item.fn(t)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test timed out')), 5000); })
      ]);
    } catch (error) { record.failures.push(error.message); }
    finally { clearTimeout(timer); }
  }
  process.stdout.write(JSON.stringify(records));
})().catch(() => { process.exitCode = 1; });
"""


def main():
    if sys.platform == "darwin" and shutil.which("osascript"):
        return subprocess.run([
            shutil.which("osascript"), "-l", "JavaScript",
            str(ROOT / "scripts/run_session_tests.jxa.js"), str(ROOT),
        ], timeout=60).returncode
    node = shutil.which("node")
    if not node:
        print("run_async_js_tests: no existing runtime; use macOS JavaScriptCore or open /app/tests/.")
        return 1
    script = "\n".join([HARNESS, *(strip_modules((ROOT / name).read_text()) for name in SOURCES), RUN])
    result = subprocess.run([node], input=script, text=True, capture_output=True, timeout=60)
    if result.returncode:
        print(result.stderr)
        return 1
    records = json.loads(result.stdout)
    failed = [record for record in records if record["failures"]]
    for record in failed:
        print(record["name"] + ": " + "; ".join(record["failures"]))
    print(f"run_async_js_tests: {len(records) - len(failed)}/{len(records)} passed (existing Node, Auth/data doubles)")
    print("note: browser DOM/modules, CDN, real Auth, SMTP and RLS remain separate checks.")
    return int(bool(failed) or not records)


if __name__ == "__main__":
    sys.exit(main())
