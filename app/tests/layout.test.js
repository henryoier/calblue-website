import * as layout from "../js/layout.js";
import { layoutLogicTests } from "./layout.logic.js";
import { test, testAsync, equal, assert } from "./runner.js";
import { homeView } from "../views/home.js";

layoutLogicTests(layout, { test, equal, assert });

test("[layout] signed-in chrome with a long email fits a 360px container", () => {
  const fixture = document.createElement("div");
  fixture.style.width = "360px";
  const headerEl = document.createElement("header");
  const navEl = document.createElement("nav");
  const footerEl = document.createElement("footer");
  headerEl.className = "app-header";
  navEl.className = "app-nav";
  footerEl.className = "app-footer";
  fixture.append(headerEl, navEl, footerEl);
  document.body.appendChild(fixture);

  layout.renderLayout({
    headerEl,
    navEl,
    footerEl,
    authenticated: true,
    roles: ["admin"],
    profile: { displayName: "", email: "a-very-long-member-address@example.com" },
    session: null,
    currentPath: "/admin/verify",
    supabaseConfigured: true,
  });

  assert(fixture.scrollWidth <= 360, `chrome overflowed: ${fixture.scrollWidth}px`);
  assert(
    [...fixture.querySelectorAll(".app-nav-list a")].every(
      (link) => Number.parseFloat(getComputedStyle(link).minHeight) >= 44
    ),
    "navigation targets should be at least 44px tall"
  );
  fixture.remove();
});

testAsync("[layout] a real 360px viewport fits chrome and readable app content", async (t) => {
  const frame = document.createElement("iframe");
  frame.title = "360px layout fixture";
  frame.style.cssText = "width:360px;height:640px;border:0;display:block";
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    const sources = await Promise.all(["../../styles.css", "../css/app.css"].map(async (path) => {
      const response = await fetch(new URL(path, import.meta.url));
      if (!response.ok) throw new Error("Local layout stylesheet could not load");
      return response.text();
    }));
    const style = doc.createElement("style");
    // Test layout without contacting the public site's Google Fonts import.
    style.textContent = sources.map((source) => source.replace(/^@import[^\n]+;\s*$/gm, "")).join("\n");
    doc.head.append(style);
    const headerEl = doc.createElement("header");
    const navEl = doc.createElement("nav");
    const mainEl = doc.createElement("main");
    const footerEl = doc.createElement("footer");
    headerEl.className = "app-header";
    navEl.className = "app-nav";
    mainEl.className = "app-main";
    footerEl.className = "app-footer";
    doc.body.append(headerEl, navEl, mainEl, footerEl);
    for (const state of [
      { authenticated: false, roles: [], profile: null },
      { authenticated: true, roles: ["admin"], profile: { displayName: "VeryLongDemoName".repeat(12) } },
    ]) {
      layout.renderLayout({ headerEl, navEl, footerEl, ...state, currentPath: "/", supabaseConfigured: true });
      homeView(mainEl, { ...state, session: null });
      t.equal(frame.contentWindow.innerWidth, 360, "this is a viewport, not just a narrow container");
      t.assert(doc.documentElement.scrollWidth <= 360, "page must not scroll horizontally");
      const heading = frame.contentWindow.getComputedStyle(mainEl.querySelector("h1"));
      t.assert(parseFloat(heading.fontSize) <= 40, "marketing heading sizes must not leak into the app");
      t.assert(parseFloat(heading.lineHeight) >= parseFloat(heading.fontSize), "heading lines must not overlap");
    }
  } finally { frame.remove(); }
});

test("[layout] untrusted names render as text, not markup", () => {
  const headerEl = document.createElement("header");
  const navEl = document.createElement("nav");
  const footerEl = document.createElement("footer");
  const name = '<img src=x onerror="alert(1)">';
  layout.renderLayout({ headerEl, navEl, footerEl, authenticated: true, roles: [],
    profile: { displayName: name }, currentPath: "/", supabaseConfigured: true });
  equal(headerEl.querySelector(".app-user").textContent, name);
  assert(!headerEl.querySelector("img"));
});
