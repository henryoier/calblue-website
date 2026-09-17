import * as auth from "../js/auth.js";
import { authLogicTests, authTestEnvironment } from "./auth.logic.js";
import { test, testAsync, equal, assert } from "./runner.js";

authLogicTests(auth, { test, equal, assert });

const pendingKey = "calblue.magic-link.v1";
function authClient() {
  const calls = { links: [], exchanges: [] };
  return {
    calls,
    auth: {
      async signInWithOtp(options) { calls.links.push(options); return { error: null }; },
      async exchangeCodeForSession(code) {
        calls.exchanges.push(code);
        return { data: { session: { access_token: "synthetic-session", user: { id: "one" } } }, error: null };
      },
    },
  };
}
function pending(environment, returnTo = "#/identity", age = 0) {
  environment.storage.setItem(pendingKey, JSON.stringify({ version: 1, createdAt: environment.clock - age, returnTo }));
}
async function rejectsCode(promise, code, t) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  t.equal(error?.code, code);
  return error;
}
function deferredAuth() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

testAsync("[auth] requesting a link uses only validated email, exact redirect and explicit signup option", async (t) => {
  const environment = authTestEnvironment({ hash: "#/sign-in?returnTo=https://evil.example" });
  const client = authClient();
  const flow = auth.createAuthFlow(environment);
  const result = await flow.requestLink(client, "  Member+club@EXAMPLE.COM  ", "#/identity");
  t.equal(result.sent, true);
  t.equal(client.calls.links.length, 1);
  t.equal(client.calls.links[0].email, "Member+club@example.com");
  t.equal(client.calls.links[0].options.emailRedirectTo, "http://localhost:8080/app/");
  t.equal(client.calls.links[0].options.shouldCreateUser, true);
  t.equal(Object.keys(client.calls.links[0].options).sort().join(","), "emailRedirectTo,shouldCreateUser");
  const stored = environment.storage.getItem(pendingKey);
  t.equal(JSON.parse(stored).returnTo, "#/identity");
  t.assert(!stored.includes("Member") && !stored.includes("example.com") && !stored.includes("synthetic-session"));
});

testAsync("[auth] invalid email and unsupported origins never request email", async (t) => {
  const client = authClient();
  const valid = auth.createAuthFlow(authTestEnvironment());
  await rejectsCode(valid.requestLink(client, "not-an-email"), "invalid_email", t);
  const wrongOrigin = auth.createAuthFlow(authTestEnvironment({ origin: "http://127.0.0.1:8080" }));
  await rejectsCode(wrongOrigin.requestLink(client, "member@example.com"), "unsupported_origin", t);
  t.equal(client.calls.links.length, 0);
});

testAsync("[auth] blocked or non-persistent storage prevents an unusable PKCE email", async (t) => {
  for (const storage of [null, { setItem() { throw new Error("quota details"); } },
    { setItem() {}, getItem() { return null; }, removeItem() {} }]) {
    const client = authClient();
    const environment = authTestEnvironment();
    environment.storage = storage;
    await rejectsCode(auth.createAuthFlow(environment).requestLink(client, "member@example.com"), "storage_unavailable", t);
    t.equal(client.calls.links.length, 0);
  }
});

testAsync("[auth] concurrent requests send one email and a stored cooldown covers reloads", async (t) => {
  const environment = authTestEnvironment();
  const client = authClient();
  const wait = deferredAuth();
  client.auth.signInWithOtp = async (request) => { client.calls.links.push(request); return wait.promise; };
  const flow = auth.createAuthFlow(environment);
  const first = flow.requestLink(client, "member@example.com");
  await rejectsCode(flow.requestLink(client, "someone@example.com"), "auth_busy", t);
  wait.resolve({ error: null });
  await first;
  await rejectsCode(auth.createAuthFlow(environment).requestLink(client, "member@example.com"), "rate_limited", t);
  t.equal(client.calls.links.length, 1);
  environment.clock += 60000;
  await flow.requestLink(client, "member@example.com", "https://evil.example");
  t.equal(client.calls.links.length, 2);
  t.equal(JSON.parse(environment.storage.getItem(pendingKey)).returnTo, "#/");
});

testAsync("[auth] failed requests also cool down and provider details never reach callers", async (t) => {
  const environment = authTestEnvironment();
  const client = authClient();
  client.auth.signInWithOtp = async () => ({ error: { message: "UNTRUSTED private provider detail", status: 500 } });
  const flow = auth.createAuthFlow(environment);
  const error = await rejectsCode(flow.requestLink(client, "member@example.com"), "request_failed", t);
  t.assert(!error.message.includes("UNTRUSTED"));
  t.equal(error.cause, undefined);
  await rejectsCode(flow.requestLink(client, "member@example.com"), "rate_limited", t);
  environment.clock += 60000;
  client.auth.signInWithOtp = async () => ({ error: { status: 429, message: "UNTRUSTED" } });
  await rejectsCode(flow.requestLink(client, "member@example.com"), "rate_limited", t);
});

testAsync("[auth] valid callbacks exchange once and restore only the stored validated destination", async (t) => {
  const environment = authTestEnvironment({ search: "?code=synthetic-code_123&next=https://evil.example", hash: "#/admin/audit" });
  pending(environment, "#/identity");
  const flow = auth.createAuthFlow(environment);
  const client = authClient();
  const first = flow.completeCallback(client);
  const second = flow.completeCallback(client);
  t.equal(first, second);
  const result = await first;
  t.equal(result.handled, true);
  t.equal(result.returnTo, "#/identity");
  t.equal(result.error, undefined);
  t.equal(client.calls.exchanges.length, 1);
  t.equal(client.calls.exchanges[0], "synthetic-code_123");
  t.equal(environment.storage.getItem(pendingKey), null);
  t.equal(await flow.completeCallback(client), result);
  t.equal(client.calls.exchanges.length, 1);
});

testAsync("[auth] SDK loader failure preserves the callback until a usable client exists", async (t) => {
  const environment = authTestEnvironment({ search: "?code=synthetic-code_123" });
  pending(environment);
  const flow = auth.createAuthFlow(environment);
  await rejectsCode(flow.completeCallback(null), "request_failed", t);
  const client = authClient();
  t.equal((await flow.completeCallback(client)).returnTo, "#/identity");
  t.equal(client.calls.exchanges.length, 1);
});

testAsync("[auth] no pending same-browser request, stale state and unsafe destinations fail before exchange", async (t) => {
  for (const state of ["missing", "expired", "future", "unsafe", "malformed"]) {
    const environment = authTestEnvironment({ search: "?code=synthetic-code_123" });
    if (state === "expired") pending(environment, "#/identity", 3600001);
    if (state === "future") pending(environment, "#/identity", -1);
    if (state === "unsafe") pending(environment, "https://evil.example");
    if (state === "malformed") environment.storage.setItem(pendingKey, "not-json");
    const client = authClient();
    const result = await auth.createAuthFlow(environment).completeCallback(client);
    t.equal(result.code, "callback_failed");
    t.assert(result.error.includes("same browser"));
    t.equal(client.calls.exchanges.length, 0);
  }
});

testAsync("[auth] implicit tokens and provider errors are scrubbed and never exchanged", async (t) => {
  for (const url of [{ hash: "#access_token=synthetic&refresh_token=private" },
    { search: "?error_description=UNTRUSTED", hash: "#code=synthetic" },
    { search: "?code=a&code=b" }]) {
    const environment = authTestEnvironment(url);
    pending(environment);
    const client = authClient();
    const flow = auth.createAuthFlow(environment);
    const result = await flow.completeCallback(client);
    t.equal(result.code, "callback_invalid");
    t.assert(!result.error.includes("UNTRUSTED"));
    t.equal(client.calls.exchanges.length, 0);
    t.equal(environment.replacements.length, 1);
  }
});

testAsync("[auth] exchange failures are not replayed and allow requesting a new link", async (t) => {
  const environment = authTestEnvironment({ search: "?code=synthetic-code_123" });
  pending(environment);
  const client = authClient();
  client.auth.exchangeCodeForSession = async (code) => {
    client.calls.exchanges.push(code);
    return { data: null, error: { message: "UNTRUSTED verifier details", code: "bad_code_verifier" } };
  };
  const flow = auth.createAuthFlow(environment);
  const result = await flow.completeCallback(client);
  t.equal(result.code, "callback_failed");
  t.equal(result.returnTo, "#/identity", "recovery preserves the validated intended destination");
  t.assert(!result.error.includes("UNTRUSTED"));
  t.equal(await flow.completeCallback(client), result);
  t.equal(client.calls.exchanges.length, 1);
  await flow.requestLink(client, "member@example.com");
  t.equal(client.calls.links.length, 1);
});

testAsync("[auth] thrown exchange errors and empty session responses stay generic", async (t) => {
  for (const throws of [true, false]) {
    const environment = authTestEnvironment({ search: "?code=synthetic-code_123" });
    pending(environment);
    const client = authClient();
    client.auth.exchangeCodeForSession = async () => {
      if (throws) throw new Error("UNTRUSTED transport detail");
      return { data: { session: null }, error: null };
    };
    const result = await auth.createAuthFlow(environment).completeCallback(client);
    t.equal(result.code, "callback_failed");
    t.assert(!result.error.includes("UNTRUSTED"));
  }
});

testAsync("[auth] callbacks on unsupported origins do not exchange and unrelated visits remain ordinary", async (t) => {
  const client = authClient();
  const environment = authTestEnvironment({ search: "?code=synthetic-code_123", origin: "https://evil.example" });
  pending(environment);
  t.equal((await auth.createAuthFlow(environment).completeCallback(client)).code, "unsupported_origin");
  t.equal((await auth.createAuthFlow(authTestEnvironment()).completeCallback(client)).handled, false);
  t.equal(client.calls.exchanges.length, 0);
});

testAsync("[auth] optional cross-tab lock is bounded and acquired before the storage cooldown check", async (t) => {
  const environment = authTestEnvironment();
  const client = authClient();
  let lockCalls = 0;
  environment.locks = { request(name, options, operation) {
    lockCalls += 1;
    t.equal(name, "calblue-magic-link");
    t.equal(options.ifAvailable, true);
    pending(environment);
    return Promise.resolve().then(() => operation({ name }));
  } };
  await rejectsCode(auth.createAuthFlow(environment).requestLink(client, "member@example.com"), "rate_limited", t);
  t.equal(lockCalls, 1);
  t.equal(client.calls.links.length, 0);
  environment.locks = { request(_name, _options, operation) { return Promise.resolve().then(() => operation(null)); } };
  await rejectsCode(auth.createAuthFlow(environment).requestLink(client, "member@example.com"), "auth_busy", t);
});

testAsync("[auth] clearing pending metadata cancels unsent work without touching SDK credentials", async (t) => {
  const environment = authTestEnvironment();
  environment.storage.setItem("sb-example-auth-token", "synthetic-sdk-owned-value");
  const flow = auth.createAuthFlow(environment);
  const client = authClient();
  const request = flow.requestLink(client, "member@example.com");
  flow.clearPending();
  await rejectsCode(request, "auth_busy", t);
  t.equal(client.calls.links.length, 0);
  t.equal(environment.storage.getItem(pendingKey), null);
  t.equal(environment.storage.getItem("sb-example-auth-token"), "synthetic-sdk-owned-value");
});

testAsync("[auth] a callback that cannot acquire the lock does not erase another tab's pending request", async (t) => {
  const environment = authTestEnvironment({ search: "?code=synthetic-code_123" });
  pending(environment);
  const original = environment.storage.getItem(pendingKey);
  environment.locks = { request(_name, _options, operation) { return Promise.resolve().then(() => operation(null)); } };
  const client = authClient();
  await auth.createAuthFlow(environment).completeCallback(client);
  t.equal(environment.storage.getItem(pendingKey), original);
  t.equal(client.calls.exchanges.length, 0);
});

testAsync("[auth] unsupported callback material does not consume a valid pending request", async (t) => {
  const environment = authTestEnvironment({ hash: "#?code=synthetic-code_123" });
  pending(environment);
  const original = environment.storage.getItem(pendingKey);
  const client = authClient();
  const result = await auth.createAuthFlow(environment).completeCallback(client);
  t.equal(result.code, "callback_invalid");
  t.equal(result.returnTo, "#/identity");
  t.equal(environment.storage.getItem(pendingKey), original);
  t.equal(client.calls.exchanges.length, 0);
});

testAsync("[auth] callback completion cannot erase a newer intent or succeed after cancellation", async (t) => {
  const environment = authTestEnvironment({ search: "?code=synthetic-code_123" });
  pending(environment);
  const client = authClient();
  const wait = deferredAuth();
  client.auth.exchangeCodeForSession = () => wait.promise;
  const flow = auth.createAuthFlow(environment);
  const finishing = flow.completeCallback(client);
  await Promise.resolve();
  flow.clearPending();
  environment.clock += 60000;
  pending(environment, "#/games");
  const replacement = environment.storage.getItem(pendingKey);
  wait.resolve({ data: { session: { access_token: "synthetic-session", user: { id: "one" } } }, error: null });
  const result = await finishing;
  t.equal(result.code, "callback_failed");
  t.equal(environment.storage.getItem(pendingKey), replacement);
});
