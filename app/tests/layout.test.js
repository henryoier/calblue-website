import * as layout from "../js/layout.js";
import { layoutLogicTests } from "./layout.logic.js";
import { test, equal, assert } from "./runner.js";

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
