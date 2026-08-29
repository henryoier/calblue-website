// Minimal browser test runner.
//
// There is no node on the development machine (ADR 0001), so tests run in the page. Open
// app/tests/ in a browser: green means every assertion passed, red lists the failures.
// The page also sets document.title and window.__testResults so a headless driver can read them.

const results = [];
const pending = [];
let current = null;

export function test(name, fn) {
  current = { name, failures: [] };
  results.push(current);
  try {
    fn();
  } catch (error) {
    current.failures.push(`threw: ${error && error.message ? error.message : error}`);
  }
  current = null;
}

export function assert(condition, message) {
  if (!condition) current.failures.push(message || "assertion failed");
}

export function equal(actual, expected, message) {
  if (actual !== expected) {
    current.failures.push(
      `${message || "not equal"}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

export function throws(fn, message) {
  try {
    fn();
    current.failures.push(message || "expected a throw, got none");
  } catch (_) {
    /* expected */
  }
}

export function testAsync(name, fn) {
  const record = { name, failures: [] };
  results.push(record);
  const scoped = {
    assert(condition, message) {
      if (!condition) record.failures.push(message || "assertion failed");
    },
    equal(actual, expected, message) {
      if (actual !== expected) {
        record.failures.push(
          `${message || "not equal"}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
        );
      }
    },
  };
  pending.push(
    Promise.resolve()
      .then(() => fn(scoped))
      .catch((error) => {
        record.failures.push(`threw: ${error && error.message ? error.message : error}`);
      })
  );
}

export async function report(into) {
  await Promise.all(pending);
  const failed = results.filter((r) => r.failures.length);
  const total = results.length;
  window.__testResults = { total, failed: failed.length, results };
  document.title = failed.length ? `FAIL ${failed.length}/${total}` : `PASS ${total}/${total}`;

  const lines = results.map((r) => {
    const ok = r.failures.length === 0;
    const detail = r.failures.map((f) => `\n      ${f}`).join("");
    return `<li class="${ok ? "ok" : "bad"}">${ok ? "PASS" : "FAIL"} — ${r.name}<pre>${detail}</pre></li>`;
  });

  into.innerHTML = `
    <p class="summary ${failed.length ? "bad" : "ok"}">
      ${failed.length ? `${failed.length} of ${total} failed` : `all ${total} passed`}
    </p>
    <ul>${lines.join("")}</ul>`;
}
