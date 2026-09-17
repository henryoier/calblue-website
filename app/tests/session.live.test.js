import { createSessionManager } from "../js/session.js";
import { sessionFixture } from "./session.logic.js";
import { testAsync } from "./runner.js";

// Isolated stores and injected SDK doubles; no Auth or database requests.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mockClient(initial = sessionFixture()) {
  let callback;
  const calls = { profiles: [], unsubscribed: 0, signOut: [], getSession: 0 };
  const client = {
    calls,
    profile: async (id) => ({ data: { id, display_name: "Profile " + id, roles: ["admin"] }, error: null }),
    auth: {
      async getSession() {
        calls.getSession += 1;
        return { data: { session: initial }, error: null };
      },
      onAuthStateChange(next) {
        callback = next;
        return { data: { subscription: { unsubscribe() { calls.unsubscribed += 1; } } } };
      },
      async refreshSession() { return { data: { session: initial }, error: null }; },
      async signOut(options) { calls.signOut.push(options); return { error: null }; },
    },
    from(table) {
      const request = { table };
      return {
        select(columns) { request.columns = columns; return this; },
        eq(column, id) { request.column = column; request.id = id; return this; },
        maybeSingle() { calls.profiles.push(request); return client.profile(request.id); },
      };
    },
    emit(event, next) { callback(event, next); },
  };
  return client;
}
async function expectReject(promise, t, message) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  t.assert(Boolean(error), message || "the operation should reject");
  return error;
}

testAsync("[session] initializes a display-only profile and refreshes access-token roles", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  await store.initSession(client);
  t.equal(store.getProfile().displayName, "Profile one");
  t.equal(store.getRoles().join(","), "player");
  t.equal(client.calls.profiles[0].columns, "id,email,display_name,phone");
  t.equal(client.calls.profiles[0].column, "id");
  t.equal(client.calls.profiles[0].id, "one");
  client.auth.refreshSession = async () => ({ data: { session: sessionFixture("one", ["treasurer"]) }, error: null });
  await store.refreshAccess(client);
  t.equal(store.getRoles().join(","), "treasurer");
  store.disposeSession();
});

testAsync("[session] auth callbacks defer SDK queries and listener notifications", async (t) => {
  const store = createSessionManager();
  const client = mockClient(null);
  await store.initSession(client);
  let notifications = 0;
  store.onSessionChange(() => { notifications += 1; });
  client.emit("SIGNED_IN", sessionFixture());
  t.equal(client.calls.profiles.length, 0, "no SDK query while auth callback holds its lock");
  t.equal(notifications, 0, "listeners may call the SDK, so they must also be deferred");
  await tick();
  t.equal(store.getProfile().displayName, "Profile one");
  t.assert(notifications > 0);
  client.emit("SIGNED_OUT", null);
  t.equal(store.getSession(), null, "local identity invalidates immediately");
  t.equal(store.getProfile(), null);
  await tick();
  store.disposeSession();
});

testAsync("[session] a sign-out event beats a delayed initial getSession response", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  const pending = deferred();
  client.auth.getSession = () => pending.promise;
  const initializing = store.initSession(client);
  await tick();
  client.emit("SIGNED_OUT", null);
  pending.resolve({ data: { session: sessionFixture("one", ["admin"]) }, error: null });
  await initializing;
  t.assert(!store.isAuthenticated());
  t.equal(store.getProfile(), null);
  t.equal(client.calls.profiles.length, 0);
  store.disposeSession();
});

testAsync("[session] a newer auth event beats a rejected initial getSession", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  const pending = deferred();
  client.auth.getSession = () => pending.promise;
  const initializing = store.initSession(client);
  await tick();
  client.emit("SIGNED_IN", sessionFixture("two", ["coach"]));
  pending.reject(new Error("old initialization failed"));
  await initializing;
  await tick();
  t.equal(store.getSession().user.id, "two");
  t.equal(store.getSessionError(), null);
  store.disposeSession();
});

testAsync("[session] active getSession failures are visible and do not authenticate", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  const failure = new Error("Auth is unavailable");
  client.auth.getSession = async () => ({ data: null, error: failure });
  await expectReject(store.initSession(client), t);
  t.equal(store.getSessionError(), failure);
  t.assert(!store.isAuthenticated());
  store.disposeSession();
});

testAsync("[session] profile errors retain safe fallback but never profile roles", async (t) => {
  for (const response of ["returned", "thrown", "missing", "wrong-user"]) {
    const store = createSessionManager();
    const client = mockClient();
    client.profile = async () => {
      if (response === "thrown") throw new Error("profile request failed");
      if (response === "returned") return { data: null, error: new Error("profile request failed") };
      return { data: response === "missing" ? null : { id: "someone-else", display_name: "Private" }, error: null };
    };
    await store.initSession(client);
    t.assert(store.isAuthenticated());
    t.equal(store.getProfile().displayName, "Fallback one");
    t.equal(store.getRoles().join(","), "player");
    t.assert(Boolean(store.getSessionError()));
    await store.signOut(client);
    t.equal(store.getProfile(), null, "profile failure cannot prevent successful sign-out");
    t.equal(store.getSessionError(), null);
    store.disposeSession();
  }
});

testAsync("[session] an old profile rejection cannot overwrite a signed-out session", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  const pending = deferred();
  client.profile = () => pending.promise;
  const initializing = store.initSession(client);
  await tick();
  client.emit("SIGNED_OUT", null);
  pending.reject(new Error("old private profile failed"));
  await initializing;
  await tick();
  t.equal(store.getSession(), null);
  t.equal(store.getProfile(), null);
  t.equal(store.getSessionError(), null);
  store.disposeSession();
});

testAsync("[session] switching accounts discards an older account's profile response", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  const pending = deferred();
  client.profile = (id) => id === "one" ? pending.promise
    : Promise.resolve({ data: { id, display_name: "Second account" }, error: null });
  const initializing = store.initSession(client);
  await tick();
  client.emit("SIGNED_IN", sessionFixture("two", ["coach"]));
  await tick();
  pending.resolve({ data: { id: "one", display_name: "Private old account" }, error: null });
  await initializing;
  t.equal(store.getProfile().displayName, "Second account");
  t.equal(store.getSession().user.id, "two");
  t.equal(store.getRoles().join(","), "coach");
  store.disposeSession();
});

testAsync("[session] reinitialization unsubscribes and fences old callbacks and requests", async (t) => {
  const store = createSessionManager();
  const first = mockClient();
  const pending = deferred();
  first.profile = () => pending.promise;
  const oldInit = store.initSession(first);
  await tick();
  first.emit("TOKEN_REFRESHED", sessionFixture("one", ["admin"]));
  const second = mockClient(sessionFixture("two", ["coach"]));
  await store.initSession(second);
  pending.reject(new Error("old profile failed"));
  await oldInit;
  first.emit("SIGNED_OUT", null);
  await tick();
  t.equal(first.calls.unsubscribed, 1);
  t.equal(store.getSession().user.id, "two");
  t.equal(store.getProfile().displayName, "Profile two");
  t.equal(store.getSessionError(), null);
  store.disposeSession();
});

testAsync("[session] successful local sign-out cannot be undone by pending token refresh", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  await store.initSession(client);
  const pending = deferred();
  client.auth.refreshSession = () => pending.promise;
  const refreshing = store.refreshAccess(client);
  await store.signOut(client);
  pending.resolve({ data: { session: sessionFixture("one", ["admin"]) }, error: null });
  await refreshing;
  client.emit("TOKEN_REFRESHED", sessionFixture("one", ["admin"]));
  await tick();
  t.equal(client.calls.signOut[0].scope, "local");
  t.assert(!store.isAuthenticated());
  t.equal(store.getProfile(), null);
  t.equal(store.getRoles().length, 0);
  client.emit("SIGNED_IN", sessionFixture("two"));
  await tick();
  t.equal(store.getSession().user.id, "two", "a later real sign-in is still accepted");
  store.disposeSession();
});

testAsync("[session] queued sign-in work cannot restore state after explicit sign-out", async (t) => {
  const store = createSessionManager();
  const client = mockClient(null);
  await store.initSession(client);
  client.emit("SIGNED_IN", sessionFixture());
  await store.signOut(client);
  await tick();
  t.assert(!store.isAuthenticated());
  t.equal(store.getProfile(), null);
  t.equal(client.calls.profiles.length, 0);
  store.disposeSession();
});

testAsync("[session] failed sign-out reports failure without claiming success", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  await store.initSession(client);
  const failure = new Error("sign-out request failed");
  client.auth.signOut = async () => ({ error: failure });
  await expectReject(store.signOut(client), t);
  t.assert(store.isAuthenticated(), "do not pretend the persisted SDK session was removed");
  t.equal(store.getSessionError(), failure);
  store.disposeSession();
});

testAsync("[session] concurrent sign-out calls share one SDK operation", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  await store.initSession(client);
  const pending = deferred();
  let calls = 0;
  client.auth.signOut = () => { calls += 1; return pending.promise; };
  const first = store.signOut(client);
  const second = store.signOut(client);
  t.equal(first, second);
  await tick();
  t.equal(calls, 1);
  pending.resolve({ error: null });
  await Promise.all([first, second]);
  t.assert(!store.isAuthenticated());
  store.disposeSession();
});

testAsync("[session] out-of-order refresh responses preserve the newest token", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  await store.initSession(client);
  const old = deferred();
  let calls = 0;
  client.auth.refreshSession = () => ++calls === 1 ? old.promise
    : Promise.resolve({ data: { session: sessionFixture("one", ["coach"]) }, error: null });
  const first = store.refreshAccess(client);
  await store.refreshAccess(client);
  old.reject(new Error("old refresh failed"));
  await first;
  t.equal(store.getRoles().join(","), "coach");
  t.equal(store.getSessionError(), null);
  store.disposeSession();
});

testAsync("[session] fatal refresh errors remain failures after the SDK emits SIGNED_OUT", async (t) => {
  for (const mode of ["returned", "thrown"]) {
    const store = createSessionManager();
    const client = mockClient();
    await store.initSession(client);
    const failure = new Error("Refresh credentials are no longer valid");
    client.auth.refreshSession = async () => {
      client.emit("SIGNED_OUT", null);
      if (mode === "thrown") throw failure;
      return { data: { session: null }, error: failure };
    };
    t.equal(await expectReject(store.refreshAccess(client), t), failure);
    t.equal(store.getSession(), null);
    t.equal(store.getProfile(), null);
    t.equal(store.getSessionError(), failure, "SDK sign-out must not turn a failed refresh into success");
    store.disposeSession();
  }
});

testAsync("[session] TOKEN_REFRESHED applies removed roles and accepts an empty profile name", async (t) => {
  const store = createSessionManager();
  const client = mockClient(sessionFixture("one", ["admin"]));
  await store.initSession(client);
  const refreshed = sessionFixture("one", []);
  client.profile = async (id) => ({ data: { id, display_name: "", roles: ["admin"] }, error: null });
  client.auth.refreshSession = async () => {
    client.emit("TOKEN_REFRESHED", refreshed);
    return { data: { session: refreshed }, error: null };
  };
  t.equal(await store.refreshAccess(client), refreshed);
  t.equal(store.getRoles().length, 0, "removed JWT roles must disappear even before profile completion");
  t.assert(store.getProfile().isEmpty, "an empty display name is valid profile data, not a missing profile");
  t.equal(store.getSessionError(), null);
  store.disposeSession();
});

testAsync("[session] a refresh error after TOKEN_REFRESHED is not reported as success", async (t) => {
  const store = createSessionManager();
  const client = mockClient(sessionFixture("one", ["admin"]));
  await store.initSession(client);
  const refreshed = sessionFixture("one", []);
  const failure = new Error("Refresh completion failed");
  client.auth.refreshSession = async () => {
    client.emit("TOKEN_REFRESHED", refreshed);
    throw failure;
  };
  t.equal(await expectReject(store.refreshAccess(client), t), failure);
  t.equal(store.getSession(), refreshed, "an error must not roll back an accepted token");
  t.equal(store.getRoles().length, 0);
  t.equal(store.getSessionError(), failure);
  store.disposeSession();
});

testAsync("[session] token refresh preserves a newer profile error for the caller", async (t) => {
  const store = createSessionManager();
  const client = mockClient(sessionFixture("one", ["admin"]));
  await store.initSession(client);
  const refreshed = sessionFixture("one", []);
  const failure = new Error("Profile unavailable after refresh");
  client.profile = async () => ({ data: null, error: failure });
  client.auth.refreshSession = async () => {
    client.emit("TOKEN_REFRESHED", refreshed);
    return { data: { session: refreshed }, error: null };
  };
  t.equal(await store.refreshAccess(client), refreshed);
  t.equal(store.getRoles().length, 0);
  t.equal(store.getSessionError(), failure);
  store.disposeSession();
});

testAsync("[session] a later sign-in supersedes a pending refresh failure", async (t) => {
  for (const account of ["one", "two"]) {
    const store = createSessionManager();
    const client = mockClient();
    await store.initSession(client);
    const pending = deferred();
    client.auth.refreshSession = () => pending.promise;
    const refreshing = store.refreshAccess(client);
    client.emit("SIGNED_IN", sessionFixture(account, ["coach"]));
    await tick();
    pending.reject(new Error("Old refresh failed"));
    await refreshing;
    t.equal(store.getSession().user.id, account);
    t.equal(store.getRoles().join(","), "coach");
    t.equal(store.getSessionError(), null);
    store.disposeSession();
  }
});

testAsync("[session] explicit sign-out supersedes a pending refresh failure", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  await store.initSession(client);
  const pending = deferred();
  client.auth.refreshSession = () => pending.promise;
  const refreshing = store.refreshAccess(client);
  await store.signOut(client);
  pending.reject(new Error("Old refresh failed"));
  await refreshing;
  t.equal(store.getSession(), null);
  t.equal(store.getProfile(), null);
  t.equal(store.getSessionError(), null);
  store.disposeSession();
});

testAsync("[session] disposal invalidates delayed work and clears private state", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  const pending = deferred();
  client.profile = () => pending.promise;
  const initializing = store.initSession(client);
  await tick();
  store.disposeSession();
  pending.resolve({ data: { id: "one", display_name: "Old private name" }, error: null });
  await initializing;
  client.emit("SIGNED_IN", sessionFixture());
  await tick();
  t.equal(client.calls.unsubscribed, 1);
  t.equal(store.getSession(), null);
  t.equal(store.getProfile(), null);
  t.equal(store.getSessionError(), null);
});

testAsync("[session] offline initialization and malformed saved tokens remain signed out", async (t) => {
  const store = createSessionManager();
  await store.initSession(null);
  t.assert(!store.isAuthenticated());
  const invalid = sessionFixture();
  invalid.access_token = "invalid";
  const client = mockClient(invalid);
  await store.initSession(client);
  t.assert(!store.isAuthenticated());
  t.assert(Boolean(store.getSessionError()));
  t.equal(client.calls.profiles.length, 0);
  store.disposeSession();
});

testAsync("[session] a broken unsubscribe cannot retain private state or block a new client", async (t) => {
  const store = createSessionManager();
  const client = mockClient();
  const subscribe = client.auth.onAuthStateChange;
  client.auth.onAuthStateChange = (callback) => {
    subscribe(callback);
    return { data: { subscription: { unsubscribe() { throw new Error("broken unsubscribe"); } } } };
  };
  await store.initSession(client);
  await store.initSession(mockClient(sessionFixture("two")));
  client.emit("SIGNED_OUT", null);
  t.equal(store.getSession().user.id, "two");
  store.disposeSession();
  t.equal(store.getSession(), null);
  t.equal(store.getProfile(), null);
});

testAsync("[session] reentrant listeners cannot publish a superseded snapshot", async (t) => {
  const store = createSessionManager();
  const client = mockClient(null);
  await store.initSession(client);
  const seen = [];
  store.onSessionChange((state) => {
    if (state.authenticated) store.initSession(null);
  });
  store.onSessionChange((state) => { seen.push(state.authenticated); });
  client.emit("SIGNED_IN", sessionFixture());
  await tick();
  t.assert(!seen.includes(true), "later listeners must not receive invalidated identity data");
  t.equal(store.getSession(), null);
  store.disposeSession();
});
