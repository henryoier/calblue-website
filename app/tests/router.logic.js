export function routerLogicTests(router, t) {
  const { parseHash, matchRoute, buildHash, routeAllowed, safeDecode } = router;
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
  });
  t.test("matchRoute matches static and param segments", () => {
    const routes = [{ pattern: "/games" }, { pattern: "/games/:id" }];
    t.assert(matchRoute(routes, "#/games") !== null);
    const m = matchRoute(routes, "#/games/123");
    t.equal(m.params.id, "123");
  });
  t.test("matchRoute returns null on no match", () => {
    t.equal(matchRoute([{ pattern: "/a" }], "#/b"), null);
  });
  t.test("buildHash encodes params and query", () => {
    t.equal(buildHash("/games/:id", { id: "a b" }, { q: "x&y" }), "#/games/a%20b?q=x%26y");
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
}
