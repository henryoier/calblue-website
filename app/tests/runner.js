// Minimal browser test runner.
//
// There is no node on the development machine (ADR 0001), so tests run in the page. Open
// app/tests/ in a browser: green means every assertion passed, red lists the failures.
// The page also sets document.title and window.__testResults so a headless driver can read them.

const results = [];
let pending = Promise.resolve();
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
  // Router/DOM tests share one browser URL and document; run async cases in order.
  pending = pending.then(() => fn(scoped)).catch((error) => {
    record.failures.push(`threw: ${error && error.message ? error.message : error}`);
  });
}

export async function report(into) {
  await pending;
  const failed = results.filter((r) => r.failures.length);
  const total = results.length;
  window.__testResults = { total, failed: failed.length, results };
  document.title = failed.length ? `FAIL ${failed.length}/${total}` : `PASS ${total}/${total}`;

  const summary = document.createElement("p");
  summary.className = `summary ${failed.length ? "bad" : "ok"}`;
  summary.textContent = failed.length ? `${failed.length} of ${total} failed` : `all ${total} passed`;
  const list = document.createElement("ul");
  for (const r of results) {
    const ok = r.failures.length === 0;
    const item = document.createElement("li");
    item.className = ok ? "ok" : "bad";
    item.textContent = `${ok ? "PASS" : "FAIL"} — ${r.name}`;
    const detail = document.createElement("pre");
    detail.textContent = r.failures.map((f) => `\n      ${f}`).join("");
    item.appendChild(detail);
    list.appendChild(item);
  }
  into.replaceChildren(summary, list);
}
