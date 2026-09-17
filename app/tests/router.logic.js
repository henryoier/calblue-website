export function routerLogicTests(router, t) {
  const { parseHash, matchRoute, buildHash, routeAllowed, safeDecode } = router;
  const rejects = (fn) => {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    t.assert(threw, "invalid route construction should throw");
  };
  t.test("parseHash defaults to /", () => {
    t.equal(parseHash("").path, "/");
    t.equal(parseHash("#").path, "/");
  });
  t.test("parseHash splits segments and query", () => {
    const r = parseHash("#/games/abc?x=1&y=2");
    t.equal(r.path, "/games/abc");
    t.equal(r.segments.join(","), "games,abc");
    t.equal(r.query.x, "1");
  });
  t.test("parseHash preserves equals signs and decodes plus as spaces", () => {
    const r = parseHash("#/sign-in?token=a=b=c&next=member+home");
    t.equal(r.query.token, "a=b=c");
    t.equal(r.query.next, "member home");
  });
  t.test("malformed percent escapes do not crash routing", () => {
    t.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
    t.equal(parseHash("#/games/%E0%A4%A").segments[1], "%E0%A4%A");
    t.equal(parseHash("#/games/%E0%A4%A").valid, false);
    t.equal(matchRoute([{ pattern: "/games/:id" }], "#/games/%E0%A4%A"), null);
  });
  t.test("malformed query encoding cannot reach an otherwise valid route", () => {
    t.equal(parseHash("#/games?next=%FF").valid, false);
    t.equal(parseHash("#/games?%E0=value").valid, false);
    t.equal(matchRoute([{ pattern: "/games" }], "#/games?next=%FF"), null);
  });
  t.test("invalid separators, dot segments and control bytes become 404 candidates", () => {
    for (const hash of ["#games", "#/games//123", "#//", "#/./games", "#/games/%2e%2e",
      "#/games/a%00b", "#/games/a%5Cb", "#/games\\123"]) {
      t.equal(parseHash(hash).valid, false, hash);
      t.equal(matchRoute([{ pattern: "/games/:id" }], hash), null, hash);
    }
    t.equal(parseHash("#/games/").path, "/games");
    t.equal(parseHash("#/games/").valid, true);
  });
  t.test("encoded slash remains one parameter with an unambiguous canonical path", () => {
    const result = parseHash("#/games/a%2fb");
    t.equal(result.valid, true);
    t.equal(result.segments.length, 2);
    t.equal(result.segments[1], "a/b");
    t.equal(result.path, "/games/a%2Fb");
    t.equal(matchRoute([{ pattern: "/games/:id" }], "#/games/a%2Fb").params.id, "a/b");
  });
  t.test("query values support Unicode, empty values and documented last-value wins", () => {
    const result = parseHash("#/games?q=%E7%90%83%E8%B5%9B&q=last&empty&name=a+b");
    t.equal(result.query.q, "last");
    t.equal(result.query.empty, "");
    t.equal(result.query.name, "a b");
    t.equal(parseHash("#/games?q=%E7%90%83%E8%B5%9B").query.q, "\u7403\u8d5b");
  });
  t.test("query records cannot mutate or inherit an object prototype", () => {
    const query = parseHash("#/?__proto__=kept&constructor=plain&toString=value").query;
    t.equal(Object.getPrototypeOf(query), null);
    t.equal(query.__proto__, "kept");
    t.equal(query.constructor, "plain");
    t.equal(query.toString, "value");
  });
  t.test("matchRoute matches static and param segments", () => {
    const routes = [{ pattern: "/games" }, { pattern: "/games/:id" }];
    t.assert(matchRoute(routes, "#/games") !== null);
    const m = matchRoute(routes, "#/games/123");
    t.equal(m.params.id, "123");
  });
  t.test("matchRoute returns null on no match", () => {
    t.equal(matchRoute([{ pattern: "/a" }], "#/b"), null);
    t.equal(matchRoute([{ pattern: "*" }], "#/b"), null);
    t.equal(matchRoute(null, "#/a"), null);
  });
  t.test("parameter records are prototype safe, including reserved property names", () => {
    const params = matchRoute([{ pattern: "/:__proto__/:constructor" }], "#/a/b").params;
    t.equal(Object.getPrototypeOf(params), null);
    t.equal(params.__proto__, "a");
    t.equal(params.constructor, "b");
    t.equal(matchRoute([{ pattern: "/:" }], "#/a"), null);
  });
  t.test("buildHash encodes params and query", () => {
    t.equal(buildHash("/games/:id", { id: "a b" }, { q: "x&y" }), "#/games/a%20b?q=x%26y");
  });
  t.test("buildHash replaces whole segments rather than parameter-name prefixes", () => {
    t.equal(buildHash("/games/:id2/:id", { id: "one", id2: "two" }), "#/games/two/one");
    t.equal(buildHash("/compare/:id/:id", { id: "x/y" }), "#/compare/x%2Fy/x%2Fy");
    t.equal(buildHash("games/"), "#/games");
  });
  t.test("buildHash rejects missing, inherited, empty and unsafe path parameters", () => {
    rejects(() => buildHash("/games/:id"));
    rejects(() => buildHash("/games/:id", Object.create({ id: "inherited" })));
    for (const value of [null, undefined, "", ".", "..", "a\\b", "a\u0000b"]) {
      rejects(() => buildHash("/games/:id", { id: value }));
    }
    for (const pattern of ["//games", "/games//next", "/games?x=1", "/games#next", "/../games"]) {
      rejects(() => buildHash(pattern));
    }
  });
  t.test("generated Unicode parameters and literal query punctuation round-trip", () => {
    const hash = buildHash("/games/:id", { id: "\u7403\u8d5b / 2" }, { q: "one+two=x&y#z" });
    const result = matchRoute([{ pattern: "/games/:id" }], hash);
    t.equal(result.params.id, "\u7403\u8d5b / 2");
    t.equal(result.query.q, "one+two=x&y#z");
  });
  t.test("routeAllowed enforces authentication and any matching role", () => {
    t.assert(routeAllowed({ pattern: "/" }, {}));
    t.assert(!routeAllowed({ auth: true }, { authenticated: false }));
    t.assert(routeAllowed({ auth: true }, { authenticated: true }));
    t.assert(routeAllowed(
      { auth: true, roles: ["admin", "treasurer"] },
      { authenticated: true, roles: ["treasurer"] },
    ));
    t.assert(!routeAllowed(
      { auth: true, roles: ["admin"] },
      { authenticated: true, roles: ["player"] },
    ));
  });
  t.test("routeAllowed matches exact typed SQL roles and fails closed on malformed claims", () => {
    for (const roles of ["admin", { admin: true }, ["ADMIN"], ["admin", 7], ["admin", null], [true], null]) {
      t.assert(!routeAllowed({ roles: ["admin"] }, { authenticated: true, roles }));
    }
    t.assert(!routeAllowed({ auth: true }, { authenticated: "true" }));
    t.assert(!routeAllowed({ roles: "admin" }, { authenticated: true, roles: ["admin"] }));
    t.assert(!routeAllowed({ roles: ["admin", 7] }, { authenticated: true, roles: ["admin"] }));
    t.assert(!routeAllowed({ auth: true }, null));
    t.assert(!routeAllowed(null, {}));
    t.assert(routeAllowed({ roles: [] }, { authenticated: false }));
    t.assert(routeAllowed({ roles: ["admin"] }, { authenticated: true, roles: ["admin"] }));
  });
}
