// Browser integration with injected session/client doubles. No SDK/CDN/backend.
import { createApp } from "../js/app.js";
import { html, mount } from "../js/dom.js";
import { testAsync } from "./runner.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { await tick(); await tick(); }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionDouble({ authenticated = false, roles = [] } = {}) {
  const listeners = new Set();
  let state = { authenticated, roles };
  const emit = () => { for (const listener of listeners) listener(state); };
  const manager = {
    initSession: async (client) => { if (!client) state = { authenticated: false, roles: [] }; emit(); },
    getSession: () => state.authenticated ? { user: { id: "test-account", email: "member@example.com" } } : null,
    getProfile: () => state.authenticated ? { displayName: "Demo Member" } : null,
    getRoles: () => state.roles,
    getSessionError: () => null,
    isAuthenticated: () => state.authenticated,
    onSessionChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    disposeSession: () => listeners.clear(),
    set: (next) => { state = next; emit(); },
    signOut: async () => manager.set({ authenticated: false, roles: [] }),
  };
  return manager;
}

function fixture(path, session = sessionDouble(), loadClient = async () => ({})) {
  const originalUrl = location.href;
  history.replaceState(null, "", "#" + path);
  const root = document.createElement("div");
  mount(root, html`
    <a id="app-skip" href="#app">Skip to content</a>
    <header id="app-header" class="app-header"></header>
    <nav id="app-nav" class="app-nav"></nav>
    <div id="app-status" class="app-status" hidden></div>
    <main id="app" class="app-main" tabindex="-1"></main>
    <footer id="app-footer" class="app-footer"></footer>
  `);
  document.body.append(root);
  const app = createApp({ root, session, loadClient, configured: () => true });
  return { app, root, session,
    main: root.querySelector("#app"),
    dispose() { app.destroy(); root.remove(); history.replaceState(null, "", originalUrl); },
  };
}

testAsync("[app] public routes, direct guards and a real 404", async (t) => {
  const view = fixture("/");
  try {
    await view.app.start();
    t.equal(view.main.querySelector("h1").textContent, "Members home");
    for (const [path, heading] of [["/games", "Games"], ["/identity", "Sign in required"],
      ["/admin/audit", "Sign in required"], ["/not-a-route", "Page not found"]]) {
      location.hash = path;
      await settle();
      t.equal(view.main.querySelector("h1").textContent, heading);
      t.equal(document.activeElement, view.main, "route content receives focus");
    }
  } finally { view.dispose(); }
});

testAsync("[app] role changes clear protected content and navigation", async (t) => {
  const view = fixture("/admin/payments", sessionDouble({ authenticated: true, roles: ["admin"] }));
  try {
    await view.app.start();
    t.equal(view.main.querySelector("h1").textContent, "Payments");
    view.session.set({ authenticated: true, roles: ["treasurer", "developer"] });
    await settle();
    t.equal(view.main.querySelector("h1").textContent, "You do not have access");
    t.equal(view.root.querySelectorAll("#app-nav a[href^='#/admin/']").length, 0);
    view.session.set({ authenticated: false, roles: [] });
    await settle();
    t.equal(view.main.querySelector("h1").textContent, "Sign in required");
    t.assert(!view.root.textContent.includes("Demo Member"), "old account details must disappear");
  } finally { view.dispose(); }
});

testAsync("[app] initialization keeps loading until session resolution", async (t) => {
  const gate = deferred();
  const session = sessionDouble();
  session.initSession = async () => {
    session.set({ authenticated: false, roles: [] });
    await gate.promise;
    session.set({ authenticated: true, roles: ["admin"] });
  };
  const view = fixture("/admin/audit", session);
  try {
    const starting = view.app.start();
    await settle();
    t.assert(view.main.textContent.includes("Starting members app"));
    t.assert(!view.main.textContent.includes("Sign in required"));
    gate.resolve();
    await starting;
    t.equal(view.main.querySelector("h1").textContent, "Audit log");
  } finally { gate.resolve(); view.dispose(); }
});

testAsync("[app] a failed client load leaves public routes and a working retry", async (t) => {
  let attempts = 0;
  const view = fixture("/games", sessionDouble(), async () => {
    if (++attempts === 1) throw new Error("simulated connection failure");
    return {};
  });
  try {
    await view.app.start();
    t.equal(view.main.querySelector("h1").textContent, "Games");
    const status = view.root.querySelector("#app-status");
    t.assert(!status.hidden && Boolean(status.querySelector("button")));
    status.querySelector("button").click();
    await settle();
    t.equal(attempts, 2);
    t.assert(status.hidden, "retry success clears connection warning");
  } finally { view.dispose(); }
});

testAsync("[app] skip link focuses content without changing the route", async (t) => {
  const view = fixture("/games");
  try {
    await view.app.start();
    const previous = location.hash;
    view.root.querySelector("#app-skip").click();
    t.equal(location.hash, previous);
    t.equal(document.activeElement, view.main);
  } finally { view.dispose(); }
});

testAsync("[app] a forged signedOut query never claims a successful sign-out", async (t) => {
  const view = fixture("/sign-in?signedOut=1");
  try {
    await view.app.start();
    t.assert(!view.main.querySelector(".app-success"));
  } finally { view.dispose(); }
});

testAsync("[app] confirmed sign-out clears chrome and shows success", async (t) => {
  const view = fixture("/", sessionDouble({ authenticated: true, roles: ["admin"] }));
  try {
    await view.app.start();
    location.hash = "/sign-out";
    await settle();
    t.assert(location.hash.startsWith("#/sign-in"));
    t.assert(Boolean(view.main.querySelector(".app-success")));
    t.assert(!view.root.textContent.includes("Demo Member"));
  } finally { view.dispose(); }
});

testAsync("[app] failed sign-out stays actionable and never claims success", async (t) => {
  const session = sessionDouble({ authenticated: true, roles: ["player"] });
  session.signOut = async () => { throw new Error("simulated sign-out failure"); };
  const view = fixture("/", session);
  try {
    await view.app.start();
    location.hash = "/sign-out";
    await settle();
    t.equal(location.hash, "#/sign-out");
    t.assert(Boolean(view.main.querySelector("[role=alert]")));
    t.assert(!view.main.querySelector(".app-success"));
    t.assert(session.isAuthenticated());
  } finally { view.dispose(); }
});

testAsync("[app] navigating away fences a late sign-out redirect", async (t) => {
  const gate = deferred();
  const session = sessionDouble({ authenticated: true, roles: ["player"] });
  session.signOut = async () => { await gate.promise; session.set({ authenticated: false, roles: [] }); };
  const view = fixture("/", session);
  try {
    await view.app.start();
    location.hash = "/sign-out";
    await settle();
    location.hash = "/games";
    await settle();
    gate.resolve();
    await settle();
    t.equal(location.hash, "#/games");
    t.equal(view.main.querySelector("h1").textContent, "Games");
  } finally { gate.resolve(); view.dispose(); }
});
