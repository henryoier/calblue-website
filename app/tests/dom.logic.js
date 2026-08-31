// Pure-logic assertions for dom.js — no DOM, no browser APIs.
//
// Kept free of DOM so the same suite runs in two places: in the browser via app/tests/, and on the
// command line via scripts/run_js_tests.py, which executes it under JavaScriptCore (osascript).
// There is no node on this machine, so that CLI path is the only way these actually get run in CI.
//
// DOM-dependent behaviour (toFragment, mount, attribute parsing) lives in dom.test.js and is
// browser-only by necessity.

export function domLogicTests(dom, t) {
  const { html, raw, escapeHtml, isRaw } = dom;
  const str = (result) => (isRaw(result) ? result[Object.getOwnPropertySymbols(result)[0]] : String(result));

  t.test("escapes the five dangerous characters", () => {
    t.equal(escapeHtml('<&>"\''), "&lt;&amp;&gt;&quot;&#39;");
  });

  t.test("escaping is single-pass, not double-applied", () => {
    t.equal(escapeHtml("&lt;"), "&amp;lt;");
  });

  t.test("interpolated values are escaped", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const out = str(html`<p>${evil}</p>`);
    t.equal(out.indexOf("<img"), -1, "must not emit a real element");
    t.assert(out.indexOf("&lt;img") !== -1, "must contain the escaped form");
  });

  t.test("a quote in an attribute position cannot break out", () => {
    const evil = '" onmouseover="alert(1)';
    const out = str(html`<a title="${evil}">x</a>`);
    t.equal(out, '<a title="&quot; onmouseover=&quot;alert(1)">x</a>');
  });

  t.test("nested html results are not double-escaped", () => {
    t.equal(str(html`<p>${html`<b>bold</b>`}</p>`), "<p><b>bold</b></p>");
  });

  t.test("arrays are flattened and each item escaped", () => {
    const items = ["a", "<b>"];
    t.equal(str(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`),
            "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  });

  t.test("nested arrays flatten recursively", () => {
    t.equal(str(html`<p>${[["a"], ["b"]]}</p>`), "<p>ab</p>");
  });

  t.test("null, undefined and false render as nothing", () => {
    t.equal(str(html`<p>${null}${undefined}${false}</p>`), "<p></p>");
  });

  t.test("zero and empty string still render", () => {
    t.equal(str(html`<p>${0}|${""}</p>`), "<p>0|</p>");
  });

  t.test("raw opts out of escaping, deliberately", () => {
    t.equal(str(html`<p>${raw("<b>x</b>")}</p>`), "<p><b>x</b></p>");
  });

  t.test("html returns a composable raw marker", () => {
    t.assert(isRaw(html`<p></p>`), "html result should be marked raw");
    t.assert(!isRaw("<p></p>"), "a bare string must not be treated as raw");
  });

  t.test("a template with no interpolations is unchanged", () => {
    t.equal(str(html`<hr>`), "<hr>");
  });
}
