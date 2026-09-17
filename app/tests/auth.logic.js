export function authTestEnvironment(overrides = {}) {
  const values = new Map();
  const location = { origin: "http://localhost:8080", pathname: "/app/", search: "", hash: "#/sign-in", ...overrides };
  const environment = {
    location,
    clock: 1000000000000,
    replacements: [],
    values,
    storage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
    history: {
      replaceState(_state, _title, url) {
        environment.replacements.push(url);
        location.search = "";
        location.hash = "#/sign-in";
      },
    },
    now: () => environment.clock,
    locks: null,
  };
  return environment;
}

export function authLogicTests(auth, t) {
  t.test("auth redirect URLs are exactly the three configured origin/path pairs", () => {
    for (const [origin, pathname] of [["http://localhost:8080", "/app/"],
      ["http://localhost:8091", "/app/"], ["https://app.calbluefc.com", "/"]]) {
      t.equal(auth.allowedRedirectUrl({ origin, pathname, search: "?code=secret", hash: "#/identity" }), origin + pathname);
    }
    for (const [origin, pathname] of [["http://127.0.0.1:8080", "/app/"],
      ["http://localhost:8081", "/app/"], ["http://localhost:8080", "/app"],
      ["https://app.calbluefc.com.evil.example", "/"], ["http://app.calbluefc.com", "/"],
      ["https://app.calbluefc.com", "/app/"], ["https://app.calbluefc.com", "/?next=evil"]]) {
      t.equal(auth.allowedRedirectUrl({ origin, pathname }), null);
    }
  });

  t.test("return destinations allow only known static internal routes", () => {
    for (const route of ["/", "/games", "/identity", "/admin/verify", "/admin/payments", "/admin/audit", "/admin/clubs"]) {
      t.equal(auth.safeReturnTo(route), "#" + route);
      t.equal(auth.safeReturnTo("#" + route), "#" + route);
    }
    for (const value of [null, {}, "https://evil.example", "//evil.example", "#//evil.example", "javascript:alert(1)",
      "#/sign-in", "#/sign-out", "#/missing", "#/identity?next=https://evil.example", "#/%69dentity", "#/../identity",
      "#/identity/", "#/identity\\evil", "#/identity\n"]) {
      t.equal(auth.safeReturnTo(value), "#/");
    }
  });

  t.test("email validation trims, preserves local-part case and normalizes the domain", () => {
    t.equal(auth.normalizeEmail("  Member+club@EXAMPLE.COM  "), "Member+club@example.com");
    for (const email of [null, {}, "", "plain-address", "a@@example.com", "a@localhost", "a@-example.com",
      "a@example..com", ".a@example.com", "a..b@example.com", "a.@example.com", "a b@example.com",
      "a\u0000@example.com", "Name <a@example.com>", "a@example.com\nBcc:b@example.com", "x".repeat(65) + "@example.com"]) {
      t.equal(auth.normalizeEmail(email), null);
    }
  });

  t.test("only a single explicit top-level PKCE code is accepted", () => {
    t.equal(auth.parseAuthCallback({ search: "?code=synthetic-code_123", hash: "" }).kind, "code");
    t.equal(auth.parseAuthCallback({ search: "?co%64e=synthetic-code_123", hash: "" }).code, "synthetic-code_123");
    t.equal(auth.parseAuthCallback({ search: "?code=synthetic-code_123&next=https://evil.example", hash: "#/admin/audit" }).kind, "code");
    t.equal(auth.parseAuthCallback({ search: "", hash: "#/identity" }).kind, "none");
    t.equal(auth.parseAuthCallback({ search: "?campaign=club", hash: "#/games" }).kind, "none");
    for (const search of ["?code=", "?code=a&code=b", "?code=a&error=denied", "?code=%broken", "?code=a+b", "?CODE=a",
      "?error_description=UNTRUSTED", "?access_token=token&refresh_token=other", "?type=recovery"]) {
      t.equal(auth.parseAuthCallback({ search, hash: "" }).kind, "error");
    }
  });

  t.test("implicit tokens, fragment codes and route-query callback material are rejected", () => {
    for (const hash of ["#code=synthetic-code_123", "#?code=synthetic-code_123", "#?access_token=token",
      "#?%63ode=synthetic-code_123", "#access_token=token&refresh_token=other",
      "#error_description=UNTRUSTED", "#/sign-in?code=synthetic-code_123", "#/games?provider_token=secret"]) {
      t.equal(auth.parseAuthCallback({ search: "", hash }).kind, "error");
      t.equal(auth.parseAuthCallback({ search: "?code=synthetic-code_123", hash }).kind, "error");
    }
  });

  t.test("factory scrubs callback material synchronously, before any SDK load", () => {
    for (const callback of [{ search: "?code=synthetic-code_123", hash: "#/identity" },
      { search: "", hash: "#?code=synthetic-code_123" },
      { search: "?error_description=UNTRUSTED", hash: "#access_token=secret" }]) {
      const environment = authTestEnvironment(callback);
      const flow = auth.createAuthFlow(environment);
      t.equal(environment.replacements.length, 1);
      t.equal(environment.replacements[0], "http://localhost:8080/app/#/sign-in");
      t.equal(environment.location.search, "");
      flow.assertSafeToLoad();
    }
    const ordinary = authTestEnvironment({ hash: "#/identity" });
    auth.createAuthFlow(ordinary);
    t.equal(ordinary.replacements.length, 0);
  });

  t.test("a failed URL scrub forbids SDK construction without leaking callback text", () => {
    const environment = authTestEnvironment({ search: "?code=private-code" });
    environment.history.replaceState = () => { throw new Error("UNTRUSTED provider details"); };
    const flow = auth.createAuthFlow(environment);
    let error;
    try { flow.assertSafeToLoad(); } catch (caught) { error = caught; }
    t.equal(error?.code, "callback_scrub_failed");
    t.assert(!error.message.includes("private-code"));
    t.assert(!error.message.includes("UNTRUSTED"));
  });
}
