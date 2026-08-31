import * as dom from "../js/dom.js";
import { domLogicTests } from "./dom.logic.js";
import { test, equal, assert } from "./runner.js";

// The pure-logic suite, shared with scripts/run_js_tests.py.
domLogicTests(dom, { test, equal, assert });

// --- browser-only: these need a real DOM and cannot run under JavaScriptCore ---

test("[dom] toFragment produces real nodes", () => {
  const host = document.createElement("div");
  host.appendChild(dom.toFragment(dom.html`<p>hi</p>`));
  equal(host.querySelector("p").textContent, "hi");
});

test("[dom] attribute break-out does not create a handler attribute", () => {
  // Asserted against the parsed DOM rather than the serialised string: the correctly escaped
  // output legitimately contains the text `onmouseover=`, so a substring check would fail here
  // for entirely the wrong reason.
  const evil = '" onmouseover="alert(1)';
  const host = document.createElement("div");
  host.appendChild(dom.toFragment(dom.html`<a title="${evil}">x</a>`));
  const anchor = host.querySelector("a");
  equal(anchor.getAttribute("onmouseover"), null, "must not break out into a handler");
  equal(anchor.getAttribute("title"), evil, "title should round-trip exactly");
});

test("[dom] injected script tags do not execute or appear as elements", () => {
  const host = document.createElement("div");
  host.appendChild(dom.toFragment(dom.html`<div>${"<script>window.__pwned=1</script>"}</div>`));
  equal(host.querySelector("script"), null, "no script element should exist");
  equal(window.__pwned, undefined, "nothing should have executed");
});

test("[dom] mount replaces children rather than appending", () => {
  const host = document.createElement("div");
  dom.mount(host, dom.html`<p>one</p>`);
  dom.mount(host, dom.html`<p>two</p>`);
  equal(host.querySelectorAll("p").length, 1);
  equal(host.querySelector("p").textContent, "two");
});

test("[dom] el throws instead of returning null", () => {
  let threw = false;
  try { dom.el("#definitely-not-there"); } catch (_) { threw = true; }
  assert(threw, "el should throw on a missing selector");
});
