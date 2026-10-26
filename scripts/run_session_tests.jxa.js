// Run the exact DOM-free browser session/provider tests with macOS JavaScriptCore.
// From the repository root:
//   osascript -l JavaScript scripts/run_session_tests.jxa.js
// An optional first argument selects another repository root.
//
// No Node, packages, network, real Auth or database requests. Native Promises run
// in a JSContext; a deterministic queue advances the suites' zero-delay timers.
// Import/export stripping is only a test harness detail. This does NOT validate
// browser DOM behavior, native module loading, CDN delivery or real sessions.

ObjC.import("Foundation");
ObjC.import("JavaScriptCore");

function run(argv) {
  const root = argv[0] || ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
  const context = $.JSContext.alloc.init;

  function evaluate(source) {
    const result = context.evaluateScript(source);
    if (ObjC.unwrap(context.exception) !== undefined) {
      throw new Error(ObjC.unwrap(context.exception.valueForProperty("message").toObject));
    }
    return result;
  }

  function source(name) {
    const value = $.NSString.stringWithContentsOfFileEncodingError(
      root + "/" + name, $.NSUTF8StringEncoding, null,
    );
    if (ObjC.unwrap(value) === undefined) throw new Error("Cannot read " + name);
    return ObjC.unwrap(value)
      .replace(/^\s*import\s+[^;]*;\s*$/gm, "")
      .replace(/^export\s+/gm, "");
  }

  evaluate(`
    var timers = [];
    function setTimeout(fn) { timers.push(fn); return timers.length; }
    var console = { warn: function () {} };
    var records = [];
    var tests = [];
    var current;
    function testAsync(name, fn) { tests.push({ name: name, fn: fn }); }
    function test(name, fn) {
      testAsync(name, function (t) { current = t; fn(); });
    }
    function assert(condition, message) { current.assert(condition, message); }
    function equal(actual, expected, message) { current.equal(actual, expected, message); }
  `);
  evaluate(source("app/js/session.js"));
  evaluate(source("app/tests/session.logic.js"));
  evaluate(source("app/tests/session.live.test.js"));
  evaluate(source("app/js/supabase.js"));
  evaluate(`var supabase = {
    configurationIsUsable: configurationIsUsable,
    createClientProvider: createClientProvider
  };`);
  evaluate(source("app/tests/supabase.logic.js"));
  evaluate(source("app/tests/supabase.test.js"));
  evaluate(source("app/js/auth.js"));
  evaluate(`var auth = { safeReturnTo, allowedRedirectUrl, normalizeEmail, parseAuthCallback, createAuthFlow };`);
  evaluate(source("app/tests/auth.logic.js"));
  evaluate(source("app/tests/auth.test.js"));
  evaluate(source("app/js/identity.js"));
  evaluate(source("app/tests/identity.logic.js"));
  evaluate(source("app/tests/identity.data.test.js"));
  evaluate(`
    var identity = { createIdentityService, validateIdentity, identityToday, IDENTITY_LIMITS };
    identityLogicTests(identity, { test, assert, equal });
    identityDataTests(identity, { testAsync });
  `);
  evaluate(source("app/js/verification.js"));
  evaluate(source("app/tests/verification.logic.js"));
  evaluate(source("app/tests/verification.data.test.js"));
  evaluate(`
    var verification = { createVerificationService, validateVerificationSearch, validateVerificationDecision, VERIFICATION_LIMITS };
    verificationLogicTests(verification, { test, assert, equal });
    verificationDataTests(verification, { testAsync });
  `);
  evaluate(source("app/js/pickup.js"));
  evaluate(source("app/tests/pickup.logic.js"));
  evaluate(source("app/tests/pickup.data.test.js"));
  evaluate(`
    var pickup = { createPickupService, validatePickupDetails, pickupLocalInput, pickupLocalToInstant, PICKUP_LIMITS };
    pickupLogicTests(pickup, { test, assert, equal });
    pickupDataTests(pickup, { testAsync });
  `);

  evaluate(`
    var done = false;
    (async function () {
      for (const item of tests) {
        const record = { name: item.name, failures: [] };
        records.push(record);
        const t = {
          assert(condition, message) {
            if (!condition) record.failures.push(message || "assertion failed");
          },
          equal(actual, expected, message) {
            if (actual !== expected) record.failures.push(
              (message || "not equal") + " | expected: " + JSON.stringify(expected)
              + " | actual: " + JSON.stringify(actual)
            );
          }
        };
        try { await item.fn(t); }
        catch (error) { record.failures.push("threw: " + error.message); }
      }
      done = true;
    })();
  `);

  // Returning from each native evaluateScript drains its Promise microtasks;
  // advancing one timer per evaluation reproduces the relevant event ordering.
  let cycles = 0;
  while (!evaluate("done").toBool && cycles < 1000) {
    evaluate("if (timers.length) timers.shift()();");
    cycles += 1;
  }
  if (!evaluate("done").toBool) throw new Error("Async tests did not settle after 1000 timer turns.");
  const records = JSON.parse(ObjC.unwrap(evaluate("JSON.stringify(records)").toObject));
  if (!records.length) throw new Error("No session/provider tests were registered.");
  const failed = records.filter((record) => record.failures.length);
  if (failed.length) throw new Error("run_session_tests: FAILED — " + failed.length + "/" + records.length
    + "\n" + failed.map((record) => record.name + ": " + record.failures.join("; ")).join("\n"));
  return "run_session_tests: ok — " + records.length + "/" + records.length
    + " passed (JavaScriptCore, deterministic timers)\n"
    + "note: DOM, native browser modules, CDN and real Auth remain separate checks.";
}
