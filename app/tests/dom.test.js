import { html, raw, escapeHtml, toFragment, isRaw } from "../js/dom.js";
import { test, equal, assert } from "./runner.js";

const render = (result) => {
  const div = document.createElement("div");
  div.appendChild(toFragment(result));
  return div.innerHTML;
};

test("escapes the five dangerous characters", () => {
  equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

test("interpolated values are escaped", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const out = render(html`<p>${evil}</p>`);
  assert(!out.includes("<img"), "must not produce a real element");
  assert(out.includes("&lt;img"), "must contain the escaped form");
});

test("escaping holds inside a quoted attribute", () => {
  // Asserted against the parsed DOM, not the serialised string: the escaped value legitimately
  // contains the text `onmouseover=`, so a substring check here would fail for the wrong reason.
  const evil = '" onmouseover="alert(1)';
  const host = document.createElement("div");
  host.appendChild(toFragment(html`<a title="${evil}">x</a>`));
  const anchor = host.querySelector("a");
  equal(anchor.getAttribute("onmouseover"), null, "must not break out into a handler attribute");
  equal(anchor.getAttribute("title"), evil, "title should round-trip exactly");
});

test("nested html results are not double-escaped", () => {
  const inner = html`<b>bold</b>`;
  equal(render(html`<p>${inner}</p>`), "<p><b>bold</b></p>");
});

test("arrays are flattened and each item escaped", () => {
  const items = ["a", "<b>"];
  const out = render(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`);
  equal(out, "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
});

test("null, undefined and false render as nothing", () => {
  equal(render(html`<p>${null}${undefined}${false}</p>`), "<p></p>");
});

test("zero and empty string still render", () => {
  equal(render(html`<p>${0}</p>`), "<p>0</p>");
});

test("raw opts out of escaping, deliberately", () => {
  equal(render(html`<p>${raw("<b>x</b>")}</p>`), "<p><b>x</b></p>");
});

test("html returns a raw marker so results compose", () => {
  assert(isRaw(html`<p></p>`), "html result should be marked raw");
});
