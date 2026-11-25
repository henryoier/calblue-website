// Browser-only app integration. Every session, Auth flow and pickup service is
// injected; no email link, SDK, database, or external service is contacted.
import { createApp } from "../js/app.js";
import { html, mount } from "../js/dom.js";
import { testAsync } from "./runner.js";
import { pickupTestOptions, pickupTestRow, pickupTestService, pickupTestGate,
  pickupTestSettle, pickupTestSubmit, pickupTestFill } from "./pickup.test.js";

const PICKUP_APP_ACCOUNT_A = "c0330000-0000-4000-8000-000000000701";
const PICKUP_APP_ACCOUNT_B = "c0330000-0000-4000-8000-000000000702";
function pickupAppSession({ authenticated = true, roles = [], accountId = PICKUP_APP_ACCOUNT_A } = {}) {
  const listeners = new Set();
  let state = { authenticated, roles, accountId };
  const emit = () => { for (const listener of listeners) listener(state); };
  const session = {
    initSession: async (client) => { if (!client) state = { ...state, authenticated: false, roles: [] }; emit(); },
    getSession: () => state.authenticated ? { user: { id: state.accountId, email: "pickup-browser@example.invalid" } } : null,
    getProfile: () => state.authenticated ? { displayName: state.displayName || "Invented organizer" } : null,
    getRoles: () => state.roles,
    getSessionError: () => null,
    isAuthenticated: () => state.authenticated,
    onSessionChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    disposeSession: () => listeners.clear(),
    set: (next) => { state = { ...state, ...next }; emit(); },
    signOut: async () => session.set({ authenticated: false, roles: [] }),
    refreshAccess: async () => {},
  };
  return session;
}
function pickupAppFactory(configure = () => ({})) {
  const instances = [];
  const factory = (scope) => {
    const service = pickupTestService([pickupTestRow()], configure(scope, instances.length));
    instances.push({ scope, service }); return service;
  };
  factory.instances = instances; return factory;
}
function pickupAppFixture({ session = pickupAppSession(), factory = pickupAppFactory(), client = {} } = {}) {
  const originalUrl = location.href; const originalTitle = document.title; const previousFocus = document.activeElement;
  history.replaceState(null, "", "#/manage/pickup");
  const root = document.createElement("div");
  mount(root, html`
    <a id="app-skip" href="#app">Skip to content</a>
    <header id="app-header" class="app-header"></header><nav id="app-nav" class="app-nav"></nav>
    <div id="app-status" class="app-status" hidden></div><main id="app" class="app-main" tabindex="-1"></main>
    <footer id="app-footer" class="app-footer"></footer>
  `);
  document.body.append(root);
  const app = createApp({ root, session, loadClient: async () => client, configured: () => true,
    authFlow: { assertSafeToLoad() {}, completeCallback: async () => ({ handled: false }), clearPending() {},
      requestLink: async () => { throw new Error("This test must not request an email link."); } },
    createPickup: factory });
  const main = root.querySelector("#app");
  return { app, root, main, session, factory,
    dispose() {
      app.destroy(); root.remove(); history.replaceState(null, "", originalUrl); document.title = originalTitle;
      if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
    } };
}
function pickupAppDraft(view, note = "PRIVATE UNSAVED PICKUP NOTE") {
  view.main.querySelector('[data-pickup-action="new"]').click();
  const form = pickupTestFill(view.main.querySelector("[data-pickup-form]"));
  const notes = form.elements.namedItem("notes"); notes.value = note;
  return { form, notes };
}

testAsync("[pickup app] signed-out routes do not construct a pickup service", async (t) => {
  const factory = pickupAppFactory(); const view = pickupAppFixture({ session: pickupAppSession({ authenticated: false }), factory });
  try {
    await view.app.start(); await pickupTestSettle();
    t.equal(factory.instances.length, 0); t.equal(view.main.querySelector("h1").textContent, "Sign in required");
    t.equal(view.root.querySelector('nav a[href="#/manage/pickup"]'), null);
    t.equal(view.main.querySelector("[data-pickup-form]"), null);
  } finally { view.dispose(); }
});

testAsync("[pickup app] authenticated team organizers need no administrator JWT claim", async (t) => {
  const client = { marker: "injected pickup client" };
  const factory = pickupAppFactory(() => ({ options: async () => pickupTestOptions({ can_override_fee: false }) }));
  const view = pickupAppFixture({ session: pickupAppSession({ roles: [] }), factory, client });
  try {
    await view.app.start(); await pickupTestSettle();
    t.equal(factory.instances.length, 1); t.equal(factory.instances[0].scope.client, client);
    t.assert(factory.instances[0].scope.isCurrent());
    t.equal(view.main.querySelector("h1").textContent, "Manage pickup games");
    t.assert(view.root.querySelector('nav a[href="#/manage/pickup"]'));
    const { form } = pickupAppDraft(view); t.equal(form.elements.namedItem("fee_override"), null);
    t.equal(factory.instances[0].service.calls.save.length, 0);
  } finally { view.dispose(); }
});

testAsync("[pickup app] authenticated navigation does not substitute for database scope authorization", async (t) => {
  const factory = pickupAppFactory(() => ({ options: async () => { throw { code: "access_denied" }; } }));
  const view = pickupAppFixture({ factory });
  try {
    await view.app.start(); await pickupTestSettle();
    t.assert(view.root.querySelector('nav a[href="#/manage/pickup"]'));
    t.equal(factory.instances[0].service.calls.list.length, 0);
    t.assert(view.main.querySelector("[data-pickup-error]").textContent.includes("organizer grant"));
    t.assert(view.main.querySelector('[data-pickup-action="new"]').disabled);
  } finally { view.dispose(); }
});

testAsync("[pickup app] same-account notifications and same-scope refresh preserve an unfinished draft", async (t) => {
  const session = pickupAppSession({ roles: ["player"] }); let refreshes = 0;
  session.refreshAccess = async () => { refreshes += 1; session.set({ displayName: "Refreshed invented organizer" }); };
  const view = pickupAppFixture({ session });
  try {
    await view.app.start(); await pickupTestSettle(); const { form, notes } = pickupAppDraft(view);
    const first = view.factory.instances[0]; session.set({ displayName: "Updated invented organizer" }); await pickupTestSettle();
    t.equal(view.main.querySelector("[data-pickup-form]"), form); t.equal(notes.value, "PRIVATE UNSAVED PICKUP NOTE");
    view.root.querySelector("[data-refresh-access]").click(); await pickupTestSettle();
    t.equal(refreshes, 1); t.equal(view.factory.instances.length, 1); t.assert(first.scope.isCurrent());
    t.equal(first.service.calls.options.length, 2, "explicit access refresh rechecks database-scoped options");
    t.equal(view.main.querySelector("[data-pickup-form]"), form); t.equal(notes.value, "PRIVATE UNSAVED PICKUP NOTE");
    t.equal(first.service.calls.save.length, 0); t.equal(first.service.calls.transition.length, 0);
    t.assert(view.root.querySelector("[data-access-status]").textContent.includes("Access refreshed"));
  } finally { view.dispose(); }
});

testAsync("[pickup app] refreshed team-grant denial clears a draft even when JWT roles are unchanged", async (t) => {
  let optionsReads = 0;
  const factory = pickupAppFactory(() => ({ options: async () => {
    if (++optionsReads > 1) throw { code: "access_denied" }; return pickupTestOptions({ can_override_fee: false });
  } }));
  const view = pickupAppFixture({ factory });
  try {
    await view.app.start(); await pickupTestSettle(); const { form, notes } = pickupAppDraft(view);
    view.root.querySelector("[data-refresh-access]").click(); await pickupTestSettle();
    t.equal(factory.instances.length, 1); t.equal(view.main.querySelector("[data-pickup-form]"), null);
    t.equal(notes.value, ""); t.equal(notes.defaultValue, ""); t.assert(!pickupTestSubmit(form).defaultPrevented);
    t.assert(view.main.querySelector("[data-pickup-error]").textContent.includes("organizer grant"));
    t.equal(factory.instances[0].service.calls.save.length, 0); t.equal(factory.instances[0].service.calls.list.length, 1);
  } finally { view.dispose(); }
});

testAsync("[pickup app] a JWT role change invalidates the old editor and rechecks the new scope", async (t) => {
  const session = pickupAppSession({ roles: ["admin"] });
  const factory = pickupAppFactory((_scope, index) => index ? {
    options: async () => { throw { code: "access_denied" }; },
  } : {});
  const view = pickupAppFixture({ session, factory });
  try {
    await view.app.start(); await pickupTestSettle(); const { form, notes } = pickupAppDraft(view);
    const first = factory.instances[0]; session.set({ roles: [] }); await pickupTestSettle();
    t.assert(!first.scope.isCurrent()); t.equal(factory.instances.length, 2);
    t.equal(notes.value, ""); t.equal(notes.defaultValue, ""); t.assert(!pickupTestSubmit(form).defaultPrevented);
    t.equal(view.main.querySelector("[data-pickup-form]"), null);
    t.assert(view.main.querySelector("[data-pickup-error]").textContent.includes("organizer grant"));
    t.equal(first.service.calls.save.length, 0);
  } finally { view.dispose(); }
});

testAsync("[pickup app] switching accounts clears the old draft and service lifetime", async (t) => {
  const session = pickupAppSession();
  const factory = pickupAppFactory((_scope, index) => index ? {
    list: async () => ({ rows: [pickupTestRow(2, { title: "Other invented account game" })], hasMore: false }),
  } : {});
  const view = pickupAppFixture({ session, factory });
  try {
    await view.app.start(); await pickupTestSettle(); const { form, notes } = pickupAppDraft(view);
    const first = factory.instances[0]; session.set({ accountId: PICKUP_APP_ACCOUNT_B }); await pickupTestSettle();
    t.assert(!first.scope.isCurrent()); t.equal(factory.instances.length, 2); t.assert(factory.instances[1].scope.isCurrent());
    t.equal(notes.value, ""); t.equal(notes.defaultValue, ""); t.assert(!pickupTestSubmit(form).defaultPrevented);
    t.assert(!view.main.textContent.includes("PRIVATE UNSAVED PICKUP NOTE"));
    t.assert(view.main.textContent.includes("Other invented account game"));
    t.equal(first.service.calls.save.length, 0);
  } finally { view.dispose(); }
});

testAsync("[pickup app] sign-out fences a pending save without claiming it was undone", async (t) => {
  const gate = pickupTestGate(); const session = pickupAppSession();
  const factory = pickupAppFactory(() => ({ save: () => gate.promise }));
  const view = pickupAppFixture({ session, factory });
  try {
    await view.app.start(); await pickupTestSettle(); const { form, notes } = pickupAppDraft(view);
    pickupTestSubmit(form); const first = factory.instances[0]; const signal = first.service.calls.save[0][1].signal;
    session.set({ authenticated: false, roles: [] }); await pickupTestSettle();
    t.assert(signal.aborted); t.assert(!first.scope.isCurrent()); t.equal(notes.value, "");
    gate.resolve(pickupTestRow(900)); await pickupTestSettle();
    t.equal(view.main.querySelector("h1").textContent, "Sign in required");
    t.equal(view.main.querySelector("[data-pickup-form]"), null); t.assert(!view.main.textContent.includes("Draft saved"));
    t.equal(first.service.calls.save.length, 1); t.equal(first.service.calls.list.length, 1);
    t.equal(view.root.querySelector('nav a[href="#/manage/pickup"]'), null);
  } finally { gate.resolve(pickupTestRow(900)); view.dispose(); }
});

testAsync("[pickup app] navigation fences a delayed list and keeps the destination screen", async (t) => {
  const gate = pickupTestGate(); const factory = pickupAppFactory(() => ({ list: () => gate.promise }));
  const view = pickupAppFixture({ factory });
  try {
    await view.app.start(); await pickupTestSettle(); const first = factory.instances[0];
    const signal = first.service.calls.list[0][0].signal;
    history.replaceState(null, "", "#/"); window.dispatchEvent(new HashChangeEvent("hashchange")); await pickupTestSettle();
    t.assert(signal.aborted); t.assert(!first.scope.isCurrent());
    const destination = view.main.textContent;
    gate.resolve({ rows: [pickupTestRow(1, { title: "LATE PRIVATE PICKUP RESULT" })], hasMore: false }); await pickupTestSettle();
    t.equal(view.main.textContent, destination); t.assert(!view.main.textContent.includes("LATE PRIVATE PICKUP RESULT"));
    t.equal(view.main.querySelector(".app-pickup"), null);
  } finally { gate.resolve({ rows: [], hasMore: false }); view.dispose(); }
});
