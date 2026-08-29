export function routerLogicTests(router, t) {
  const { parseHash, matchRoute, buildHash } = router;
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
}
