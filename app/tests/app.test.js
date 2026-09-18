// Browser integration with injected session/client doubles. No SDK/CDN/backend.
import { createApp } from "../js/app.js";
import { html, mount } from "../js/dom.js";
import { testAsync } from "./runner.js";

const ACCOUNT_A = "a1100000-0000-4000-8000-000000000001";
const ACCOUNT_B = "a1100000-0000-4000-8000-000000000002";
const PLAYER_A = "b1100000-0000-4000-8000-000000000001";
const PLAYER_B = "b1100000-0000-4000-8000-000000000002";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { await tick(); await tick(); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function sessionDouble({ authenticated = false, roles = [], accountId = ACCOUNT_A } = {}) {
  const listeners = new Set();
  let state = { authenticated, roles, accountId };
  const emit = () => { for (const listener of listeners) listener(state); };
  const manager = {
    initSession: async (client) => { if (!client) state = { ...state, authenticated: false, roles: [] }; emit(); },
    getSession: () => state.authenticated ? { user: { id: state.accountId, email: "member@example.com" } } : null,
    getProfile: () => state.authenticated ? { displayName: state.displayName || "Demo Member" } : null,
    getRoles: () => state.roles,
    getSessionError: () => null,
    isAuthenticated: () => state.authenticated,
    onSessionChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    disposeSession: () => listeners.clear(),
    set: (next) => { state = { ...state, ...next }; emit(); },
    signOut: async () => manager.set({ authenticated: false, roles: [] }),
    refreshAccess: async () => {},
  };
  return manager;
}

function authDouble(overrides = {}) {
  return { assertSafeToLoad() {}, completeCallback: async () => ({ handled: false }),
    requestLink: async () => ({ sent: true }), clearPending() {}, ...overrides };
}

function identityRecord(accountId = ACCOUNT_A, overrides = {}) {
  return {
    id: accountId === ACCOUNT_A ? PLAYER_A : PLAYER_B,
    account_id: accountId,
    guardian_account_id: null,
    display_name: accountId === ACCOUNT_A ? "First private identity" : "Second private identity",
    verification_status: "pending",
    is_public: false,
    default_positions: [],
    preferred_number: null,
    legal_name: "Invented Example Member",
    date_of_birth: "1990-02-14",
    jersey_size: "M",
    emergency_contact_name: "Invented Contact",
    emergency_contact_phone: "",
    medical_notes: "Private test medical note",
    verification_note: null,
    ...overrides,
  };
}

function identitySummary(row) {
  return Object.fromEntries(["id", "account_id", "guardian_account_id", "display_name",
    "verification_status", "is_public", "default_positions", "preferred_number"]
    .map((key) => [key, row[key]]));
}

function identityFactoryDouble(configure = () => ({})) {
  const instances = [];
  const createIdentity = (scope) => {
    const implementations = {
      list: async () => ({ own: null, children: [] }),
      load: async () => identityRecord(scope.accountId),
      create: async (_kind, values) => identityRecord(scope.accountId, values),
      update: async (_id, values) => identityRecord(scope.accountId, values),
      ...configure(scope),
    };
    const instance = { scope, requests: { list: [], load: [], create: [], update: [] }, service: {} };
    for (const method of Object.keys(instance.requests)) {
      instance.service[method] = (...args) => {
        instance.requests[method].push(args);
        return Promise.resolve().then(() => implementations[method](...args));
      };
    }
    instances.push(instance);
    return instance.service;
  };
  createIdentity.instances = instances;
  return createIdentity;
}

function ownedIdentityFactory(overrides = () => ({})) {
  return identityFactoryDouble((scope) => {
    const row = identityRecord(scope.accountId);
    return {
      list: async () => ({ own: identitySummary(row), children: [] }),
      load: async () => ({ ...row }),
      ...overrides(scope),
    };
  });
}

async function openIdentity(view, id = PLAYER_A) {
  const button = view.main.querySelector(`[data-identity-action="open"][data-identity-id="${id}"]`);
  if (!button) throw new Error("Expected an identity summary to open.");
  button.click();
  await settle();
  const form = view.main.querySelector("[data-identity-form]");
  if (!form) throw new Error("Expected the selected identity editor.");
  return form;
}

function changeIdentityName(form, value) {
  const input = form.querySelector('[name="display_name"]');
  if (!input) throw new Error("Expected the editable identity display name.");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

function verificationRecord(overrides = {}) {
  return { id: PLAYER_A, display_name: "Invented pending member", legal_name: "Invented legal name",
    verification_status: "pending", verification_note: null,
    created_at: "2026-09-18T10:00:00.123456+00:00", updated_at: "2026-09-18T10:00:00.123456+00:00",
    decided_by: null, decided_at: null, ...overrides };
}

function verificationFactoryDouble(configure = () => ({})) {
  const instances = [];
  const factory = (scope) => {
    const implementations = {
      list: async () => ({ rows: [verificationRecord()], hasMore: false }),
      decide: async (rows, status, note) => rows.map((row) => verificationRecord({ ...row,
        verification_status: status, verification_note: note || null, decided_by: ACCOUNT_A,
        decided_at: "2026-09-18T11:00:00.123456+00:00", updated_at: "2026-09-18T11:00:00.123456+00:00" })),
      ...configure(scope),
    };
    const instance = { scope, requests: { list: [], decide: [] }, service: {} };
    for (const method of ["list", "decide"]) {
      instance.service[method] = (...args) => {
        instance.requests[method].push(args);
        return Promise.resolve().then(() => implementations[method](...args));
      };
    }
    instances.push(instance);
    return instance.service;
  };
  factory.instances = instances;
  return factory;
}

async function openVerificationDraft(view) {
  view.main.querySelector('[data-verification-action="reject"]').click();
  await settle();
  const form = view.main.querySelector("[data-verification-form]");
  const note = form.querySelector('[name="note"]');
  note.value = "Private unsaved decision note";
  note.dispatchEvent(new Event("input", { bubbles: true }));
  return { form, note };
}

function fixture(path, session = sessionDouble(), loadClient = async () => ({}), authFlow = authDouble(),
  createIdentity = identityFactoryDouble(), createVerification = verificationFactoryDouble()) {
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
  const app = createApp({ root, session, loadClient, configured: () => true, authFlow, createIdentity, createVerification });
  return { app, root, session, identity: createIdentity,
    main: root.querySelector("#app"),
    dispose() { app.destroy(); root.remove(); history.replaceState(null, "", originalUrl); },
  };
}

testAsync("[app] verification denies signed-out and non-admin routes without loading private records", async (t) => {
  for (const state of [{}, { authenticated: true, roles: [] }, { authenticated: true, roles: ["developer", "treasurer"] }]) {
    const factory = verificationFactoryDouble();
    const view = fixture("/admin/verify", sessionDouble(state), undefined, undefined, undefined, factory);
    try {
      await view.app.start(); await settle();
      t.equal(factory.instances.length, 0);
      t.equal(view.main.querySelector("h1").textContent, state.authenticated ? "You do not have access" : "Sign in required");
    } finally { view.dispose(); }
  }
});

testAsync("[app] verification loads with a captured client and admin-bound lifetime", async (t) => {
  const factory = verificationFactoryDouble();
  const client = { testClient: "verification" };
  const view = fixture("/admin/verify", sessionDouble({ authenticated: true, roles: ["admin"] }),
    async () => client, undefined, undefined, factory);
  try {
    await view.app.start(); await settle();
    t.equal(view.main.querySelector("h1").textContent, "Verify players");
    t.equal(factory.instances.length, 1);
    t.equal(factory.instances[0].scope.client, client);
    t.equal(factory.instances[0].scope.isCurrent(), true);
    t.assert(factory.instances[0].requests.list[0][0].signal);
  } finally { view.dispose(); }
});

testAsync("[app] same-admin notifications and access refresh preserve the decision draft", async (t) => {
  const factory = verificationFactoryDouble();
  const session = sessionDouble({ authenticated: true, roles: ["admin"] });
  session.refreshAccess = async () => session.set({ roles: ["admin", "player"] });
  const view = fixture("/admin/verify", session, undefined, undefined, undefined, factory);
  try {
    await view.app.start(); await settle();
    const { form, note } = await openVerificationDraft(view);
    session.set({ displayName: "Updated administrator" });
    await settle();
    view.root.querySelector("[data-refresh-access]").click();
    await settle();
    t.equal(view.main.querySelector("[data-verification-form]"), form);
    t.equal(note.value, "Private unsaved decision note");
    t.equal(factory.instances.length, 1);
    t.equal(factory.instances[0].requests.list.length, 1);
    t.equal(factory.instances[0].requests.decide.length, 0);
    t.assert(view.root.querySelector("[data-access-status]").textContent.includes("Access refreshed"));
  } finally { view.dispose(); }
});

testAsync("[app] role revocation or sign-out wipes private verification notes and invalidates service access", async (t) => {
  for (const next of [{ roles: [] }, { authenticated: false, roles: [] }]) {
    const factory = verificationFactoryDouble();
    const session = sessionDouble({ authenticated: true, roles: ["admin"] });
    const view = fixture("/admin/verify", session, undefined, undefined, undefined, factory);
    try {
      await view.app.start(); await settle();
      const { form, note } = await openVerificationDraft(view);
      const old = factory.instances[0];
      session.set(next);
      t.equal(old.scope.isCurrent(), false);
      await settle();
      t.equal(note.value, "");
      t.assert(!form.isConnected);
      t.assert(old.requests.list[0][0].signal.aborted);
      t.equal(view.main.querySelector("[data-verification-form]"), null);
      t.assert(!view.main.textContent.includes("Invented legal name"));
      t.equal(factory.instances.length, 1);
      t.equal(old.requests.decide.length, 0);
    } finally { view.dispose(); }
  }
});

testAsync("[app] a switch between admin accounts clears the prior verification draft and scope", async (t) => {
  const factory = verificationFactoryDouble();
  const session = sessionDouble({ authenticated: true, roles: ["admin"] });
  const view = fixture("/admin/verify", session, undefined, undefined, undefined, factory);
  try {
    await view.app.start(); await settle();
    const { form, note } = await openVerificationDraft(view);
    const old = factory.instances[0];
    session.set({ accountId: ACCOUNT_B });
    t.equal(old.scope.isCurrent(), false);
    await settle();
    t.equal(note.value, "");
    t.assert(!form.isConnected);
    t.equal(factory.instances.length, 2);
    t.equal(factory.instances[1].scope.isCurrent(), true);
    t.equal(view.main.querySelector("[data-verification-form]"), null);
  } finally { view.dispose(); }
});

testAsync("[app] late verification results cannot render after admin access is lost", async (t) => {
  const gate = deferred();
  const factory = verificationFactoryDouble(() => ({ list: () => gate.promise }));
  const session = sessionDouble({ authenticated: true, roles: ["admin"] });
  const view = fixture("/admin/verify", session, undefined, undefined, undefined, factory);
  try {
    await view.app.start(); await settle();
    session.set({ roles: [] });
    gate.resolve({ rows: [verificationRecord()], hasMore: false });
    await settle();
    t.equal(factory.instances[0].scope.isCurrent(), false);
    t.assert(factory.instances[0].requests.list[0][0].signal.aborted);
    t.equal(view.main.querySelector("h1").textContent, "You do not have access");
    t.assert(!view.main.textContent.includes("Invented pending member"));
  } finally { gate.resolve({ rows: [], hasMore: false }); view.dispose(); }
});

testAsync("[app] a dispatched decision cannot restore private data or follow-up work after revocation", async (t) => {
  const gate = deferred();
  const factory = verificationFactoryDouble(() => ({ decide: () => gate.promise }));
  const session = sessionDouble({ authenticated: true, roles: ["admin"] });
  const view = fixture("/admin/verify", session, undefined, undefined, undefined, factory);
  try {
    await view.app.start(); await settle();
    const { form, note } = await openVerificationDraft(view);
    form.querySelector('[data-verification-action="confirm"]').click();
    await settle();
    const old = factory.instances[0];
    t.equal(old.requests.decide.length, 1);
    session.set({ roles: [] });
    gate.resolve([verificationRecord({ verification_status: "rejected", verification_note: "Private unsaved decision note" })]);
    await settle();
    t.assert(old.requests.decide[0][3].signal.aborted);
    t.equal(old.scope.isCurrent(), false);
    t.equal(note.value, "");
    t.equal(view.main.querySelector("h1").textContent, "You do not have access");
    t.equal(old.requests.list.length, 1);
    t.equal(old.requests.decide.length, 1);
    t.assert(!view.main.textContent.includes("Private unsaved decision note"));
  } finally { gate.resolve([]); view.dispose(); }
});

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

testAsync("[app] protected deep links preserve their intended sign-in destination", async (t) => {
  const view = fixture("/identity");
  try {
    await view.app.start();
    const link = view.main.querySelector("a");
    t.equal(link.getAttribute("href"), "#/sign-in?returnTo=%23%2Fidentity");
    link.click();
    await settle();
    t.assert(Boolean(view.main.querySelector("input[type=email]")), "sign-in form is available");
  } finally { view.dispose(); }
});

testAsync("[app] callback is checked before SDK load and exchanged before profile bootstrap", async (t) => {
  const calls = [];
  const session = sessionDouble();
  session.initSession = async () => {
    calls.push("session");
    session.set({ authenticated: true, roles: [] });
  };
  const flow = authDouble({
    assertSafeToLoad: () => calls.push("scrub-check"),
    completeCallback: async () => { calls.push("callback"); return { handled: true, returnTo: "#/identity" }; },
  });
  const view = fixture("/", session, async () => { calls.push("client"); return {}; }, flow);
  try {
    await view.app.start();
    t.equal(calls.join(","), "scrub-check,client,callback,session");
    t.equal(location.hash, "#/identity");
    t.equal(view.main.querySelector("h1").textContent, "My identity");
    await view.app.start();
    t.equal(calls.filter((item) => item === "callback").length, 1, "retry never consumes a callback twice");
  } finally { view.dispose(); }
});

testAsync("[app] failed callback URL scrubbing never loads the SDK", async (t) => {
  let loads = 0;
  const view = fixture("/", sessionDouble(), async () => { loads += 1; return {}; }, authDouble({
    assertSafeToLoad() { throw new Error("Cannot remove callback"); },
  }));
  try {
    await view.app.start();
    t.equal(loads, 0);
    t.assert(Boolean(view.root.querySelector("#app-status [role=alert]")));
  } finally { view.dispose(); }
});

testAsync("[app] expired callback opens a recovery form without rendering provider text", async (t) => {
  const view = fixture("/", sessionDouble(), async () => ({}), authDouble({
    completeCallback: async () => ({ handled: true, error: "expired", returnTo: "#/identity" }),
  }));
  try {
    await view.app.start();
    t.assert(location.hash.startsWith("#/sign-in?returnTo="));
    t.assert(Boolean(view.main.querySelector("[role=alert]")));
    t.assert(Boolean(view.main.querySelector("input[type=email]")));
  } finally { view.dispose(); }
});

testAsync("[app] refresh access coalesces clicks and removes revoked admin navigation", async (t) => {
  const gate = deferred();
  let calls = 0;
  const session = sessionDouble({ authenticated: true, roles: ["admin"] });
  session.refreshAccess = async () => {
    calls += 1;
    await gate.promise;
    session.set({ authenticated: true, roles: ["player"] });
  };
  const view = fixture("/admin/audit", session);
  try {
    await view.app.start();
    view.root.querySelector("[data-refresh-access]").click();
    view.root.querySelector("[data-refresh-access]").click();
    t.equal(calls, 1);
    t.assert(view.root.querySelector("[data-refresh-access]").disabled);
    gate.resolve();
    await settle();
    t.equal(view.main.querySelector("h1").textContent, "You do not have access");
    t.equal(view.root.querySelectorAll("#app-nav a[href^='#/admin/']").length, 0);
    t.assert(view.root.querySelector("[data-access-status]").textContent.includes("Access refreshed"));
  } finally { gate.resolve(); view.dispose(); }
});

testAsync("[app] failed access refresh is actionable and cannot claim success", async (t) => {
  const session = sessionDouble({ authenticated: true, roles: ["player"] });
  session.refreshAccess = async () => { throw new Error("private provider details"); };
  const view = fixture("/", session);
  try {
    await view.app.start();
    view.root.querySelector("[data-refresh-access]").click();
    await settle();
    const status = view.root.querySelector("[data-access-status]");
    t.equal(status.getAttribute("role"), "alert");
    t.assert(status.textContent.includes("could not be refreshed"));
    t.assert(!view.root.textContent.includes("private provider details"));
    t.assert(!view.root.querySelector("[data-refresh-access]").disabled);
  } finally { view.dispose(); }
});

testAsync("[app] a first-login profile with no display name uses its email", async (t) => {
  const session = sessionDouble({ authenticated: true, roles: [] });
  session.getProfile = () => ({ displayName: "", email: "new-member@example.com", isEmpty: true });
  const view = fixture("/", session);
  try {
    await view.app.start();
    t.equal(view.root.querySelector(".app-user").textContent, "new-member@example.com");
    t.assert(view.main.textContent.includes("does not have a display name yet"));
    t.assert(!view.root.textContent.includes("undefined"));
  } finally { view.dispose(); }
});

testAsync("[app] navigating away and back during callback exchange preserves the user's route", async (t) => {
  const gate = deferred();
  const view = fixture("/", sessionDouble({ authenticated: true, roles: [] }), async () => ({}), authDouble({
    completeCallback: () => gate.promise,
  }));
  try {
    const starting = view.app.start();
    await settle();
    location.hash = "/games";
    await settle();
    location.hash = "/";
    await settle();
    gate.resolve({ handled: true, returnTo: "#/identity" });
    await starting;
    t.equal(location.hash, "#/", "returning to the original hash is still deliberate navigation");
    t.equal(view.main.querySelector("h1").textContent, "Members home");
  } finally { gate.resolve({ handled: false }); view.dispose(); }
});

testAsync("[app] an authenticated account without roles opens its own identity screen", async (t) => {
  const client = { testClient: "identity-client" };
  const session = sessionDouble({ authenticated: true, roles: [], accountId: ACCOUNT_A });
  const view = fixture("/identity", session, async () => client);
  try {
    await view.app.start();
    await settle();
    t.equal(view.main.querySelector("h1").textContent, "My identity");
    t.assert(Boolean(view.main.querySelector('[data-identity-action="create-self"]')));
    t.equal(view.root.querySelectorAll("#app-nav a[href^='#/admin/']").length, 0);
    t.equal(view.identity.instances.length, 1);
    const instance = view.identity.instances[0];
    t.equal(instance.scope.accountId, ACCOUNT_A);
    t.equal(instance.scope.client, client);
    t.equal(instance.scope.isCurrent(), true);
    t.equal(instance.requests.list.length, 1);
    t.equal(instance.requests.load.length, 0, "private identity details require an explicit open action");
    t.assert(Boolean(instance.requests.list[0][0]?.signal), "identity reads receive the route's cancellation signal");
  } finally { view.dispose(); }
});

testAsync("[app] same-account notifications preserve the identity draft while updating chrome and roles", async (t) => {
  const identities = ownedIdentityFactory();
  const session = sessionDouble({ authenticated: true, roles: [] });
  const view = fixture("/identity", session, async () => ({}), authDouble(), identities);
  try {
    await view.app.start();
    await settle();
    const form = await openIdentity(view);
    const name = changeIdentityName(form, "Unsaved member draft");
    session.set({ roles: ["admin"], displayName: "Updated account display" });
    await settle();
    t.equal(view.main.querySelector("[data-identity-form]"), form);
    t.equal(name.value, "Unsaved member draft");
    t.equal(view.root.querySelector(".app-user").textContent, "Updated account display");
    t.equal(view.root.querySelectorAll("#app-nav a[href^='#/admin/']").length, 4);
    session.set({ roles: [] });
    await settle();
    t.equal(view.main.querySelector("[data-identity-form]"), form);
    t.equal(name.value, "Unsaved member draft");
    t.equal(view.root.querySelectorAll("#app-nav a[href^='#/admin/']").length, 0);
    t.equal(identities.instances.length, 1, "same account notifications must not recreate the identity service");
    t.equal(identities.instances[0].requests.load.length, 1);
    t.equal(identities.instances[0].requests.update.length, 0, "a role refresh must never auto-save a draft");
  } finally { view.dispose(); }
});

testAsync("[app] manual access refresh preserves the identity form and unfinished edits", async (t) => {
  const gate = deferred();
  const identities = ownedIdentityFactory();
  const session = sessionDouble({ authenticated: true, roles: ["admin"] });
  let refreshCalls = 0;
  session.refreshAccess = async () => {
    refreshCalls += 1;
    await gate.promise;
    session.set({ roles: [] });
  };
  const view = fixture("/identity", session, async () => ({}), authDouble(), identities);
  try {
    await view.app.start();
    await settle();
    const form = await openIdentity(view);
    const name = changeIdentityName(form, "Draft survives access refresh");
    view.root.querySelector("[data-refresh-access]").click();
    t.equal(refreshCalls, 1);
    t.assert(view.root.querySelector("[data-refresh-access]").disabled);
    t.equal(view.main.querySelector("[data-identity-form]"), form);
    t.equal(name.value, "Draft survives access refresh");
    gate.resolve();
    await settle();
    t.equal(view.main.querySelector("[data-identity-form]"), form);
    t.equal(name.value, "Draft survives access refresh");
    t.equal(identities.instances.length, 1);
    t.equal(identities.instances[0].requests.load.length, 1);
    t.equal(identities.instances[0].requests.update.length, 0);
    t.equal(view.root.querySelectorAll("#app-nav a[href^='#/admin/']").length, 0);
    t.assert(view.root.querySelector("[data-access-status]").textContent.includes("Access refreshed"));
  } finally { gate.resolve(); view.dispose(); }
});

testAsync("[app] a same-account notification does not restart an in-flight identity list", async (t) => {
  const gate = deferred();
  const identities = ownedIdentityFactory(() => ({ list: () => gate.promise }));
  const session = sessionDouble({ authenticated: true, roles: [] });
  const view = fixture("/identity", session, async () => ({}), authDouble(), identities);
  try {
    const starting = view.app.start();
    await settle();
    session.set({ roles: ["player"] });
    await settle();
    t.equal(identities.instances.length, 1);
    t.equal(identities.instances[0].requests.list.length, 1);
    t.equal(identities.instances[0].scope.isCurrent(), true);
    gate.resolve({ own: identitySummary(identityRecord()), children: [] });
    await starting;
    await settle();
    t.assert(view.main.querySelector("[data-identity-list]").textContent.includes("First private identity"));
  } finally { gate.resolve({ own: null, children: [] }); view.dispose(); }
});

testAsync("[app] switching accounts clears the old private editor and creates a newly scoped service", async (t) => {
  const identities = ownedIdentityFactory();
  const client = { testClient: "shared-sdk-client" };
  const session = sessionDouble({ authenticated: true, roles: [], accountId: ACCOUNT_A });
  const view = fixture("/identity", session, async () => client, authDouble(), identities);
  try {
    await view.app.start();
    await settle();
    const oldForm = await openIdentity(view);
    const oldName = changeIdentityName(oldForm, "Private old-account draft");
    const oldScope = identities.instances[0].scope;
    const oldSignal = identities.instances[0].requests.load[0][1]?.signal;
    session.set({ accountId: ACCOUNT_B, displayName: "Second account" });
    t.equal(oldScope.isCurrent(), false, "old account access is invalid immediately");
    await settle();
    t.assert(!oldForm.isConnected);
    t.equal(oldName.value, "", "cleanup clears private values even from the detached form");
    t.assert(oldSignal?.aborted, "switching account aborts the old private read context");
    t.equal(identities.instances.length, 2);
    t.equal(identities.instances[1].scope.accountId, ACCOUNT_B);
    t.equal(identities.instances[1].scope.client, client);
    t.equal(identities.instances[1].scope.isCurrent(), true);
    t.assert(view.main.querySelector("[data-identity-list]").textContent.includes("Second private identity"));
    t.assert(!view.main.textContent.includes("First private identity"));
    t.assert(!view.main.querySelector("[data-identity-form]"), "the next account has not opened private details");
  } finally { view.dispose(); }
});

testAsync("[app] auth loss aborts the identity context and discards its unsaved private form", async (t) => {
  const identities = ownedIdentityFactory();
  const session = sessionDouble({ authenticated: true, roles: [] });
  const view = fixture("/identity", session, async () => ({}), authDouble(), identities);
  try {
    await view.app.start();
    await settle();
    const form = await openIdentity(view);
    const name = changeIdentityName(form, "Do not retain this private draft");
    const old = identities.instances[0];
    session.set({ authenticated: false, roles: [] });
    t.equal(old.scope.isCurrent(), false);
    await settle();
    t.equal(view.main.querySelector("h1").textContent, "Sign in required");
    t.assert(!form.isConnected);
    t.equal(name.value, "");
    t.assert(old.requests.load[0][1]?.signal?.aborted);
    t.assert(!view.main.querySelector("[data-identity-form]"));
    t.assert(!view.root.textContent.includes("First private identity"));
    t.equal(identities.instances.length, 1, "a signed-out account must not create an identity service");
  } finally { view.dispose(); }
});

testAsync("[app] an old account's late identity list cannot replace the new account's summaries", async (t) => {
  const gate = deferred();
  const identities = ownedIdentityFactory(({ accountId }) => accountId === ACCOUNT_A ? { list: () => gate.promise } : {});
  const session = sessionDouble({ authenticated: true, roles: [] });
  const view = fixture("/identity", session, async () => ({}), authDouble(), identities);
  try {
    const starting = view.app.start();
    await settle();
    session.set({ accountId: ACCOUNT_B });
    await settle();
    gate.resolve({ own: identitySummary(identityRecord()), children: [] });
    await starting;
    await settle();
    t.equal(identities.instances[0].scope.isCurrent(), false);
    t.assert(identities.instances[0].requests.list[0][0]?.signal?.aborted);
    t.assert(view.main.querySelector("[data-identity-list]").textContent.includes("Second private identity"));
    t.assert(!view.main.textContent.includes("First private identity"));
  } finally { gate.resolve({ own: null, children: [] }); view.dispose(); }
});

testAsync("[app] late private-detail success and failure cannot render across account changes", async (t) => {
  for (const rejectOld of [false, true]) {
    const gate = deferred();
    const identities = ownedIdentityFactory(({ accountId }) => accountId === ACCOUNT_A ? { load: () => gate.promise } : {});
    const session = sessionDouble({ authenticated: true, roles: [] });
    const view = fixture("/identity", session, async () => ({}), authDouble(), identities);
    try {
      await view.app.start();
      await settle();
      view.main.querySelector('[data-identity-action="open"]').click();
      await settle();
      t.equal(identities.instances[0].requests.load.length, 1);
      session.set({ accountId: ACCOUNT_B });
      await settle();
      if (rejectOld) gate.reject(new Error("Old account private load failed"));
      else gate.resolve(identityRecord());
      await settle();
      t.equal(identities.instances[0].scope.isCurrent(), false);
      t.assert(identities.instances[0].requests.load[0][1]?.signal?.aborted);
      t.assert(view.main.querySelector("[data-identity-list]").textContent.includes("Second private identity"));
      t.assert(!view.main.querySelector("[data-identity-form]"));
      t.equal(view.main.querySelector("[data-identity-error]")?.textContent.trim() || "", "");
      t.assert(!view.main.textContent.includes("Private test medical note"));
    } finally { gate.resolve(identityRecord()); view.dispose(); }
  }
});

testAsync("[app] a late save cannot restore the old account's editor or show success after an account switch", async (t) => {
  const gate = deferred();
  const identities = ownedIdentityFactory(({ accountId }) => accountId === ACCOUNT_A ? { update: () => gate.promise } : {});
  const session = sessionDouble({ authenticated: true, roles: [] });
  const view = fixture("/identity", session, async () => ({}), authDouble(), identities);
  try {
    await view.app.start();
    await settle();
    const form = await openIdentity(view);
    const name = changeIdentityName(form, "Old account pending save");
    form.querySelector('[data-identity-action="save"]').click();
    await settle();
    const old = identities.instances[0];
    t.equal(old.requests.update.length, 1);
    t.equal(old.requests.update[0][0], PLAYER_A);
    t.equal(old.requests.update[0][1].display_name, "Old account pending save");
    session.set({ accountId: ACCOUNT_B });
    await settle();
    gate.resolve(identityRecord(ACCOUNT_A, { display_name: "Old account pending save" }));
    await settle();
    t.equal(old.scope.isCurrent(), false);
    t.assert(old.requests.update[0][2]?.signal?.aborted);
    t.assert(!form.isConnected);
    t.equal(name.value, "");
    t.assert(view.main.querySelector("[data-identity-list]").textContent.includes("Second private identity"));
    t.assert(!view.main.querySelector("[data-identity-form]"));
    t.assert(!view.main.textContent.includes("Old account pending save"));
    t.equal(view.main.querySelector("[data-identity-status]")?.textContent.trim() || "", "");
    t.equal(old.requests.list.length, 1, "late completion must not initiate another old-account list request");
  } finally { gate.resolve(identityRecord()); view.dispose(); }
});
