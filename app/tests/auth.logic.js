export function authLogicTests(m, t) {
  t.test("validateEmail accepts normal, rejects bad", () => {
    t.assert(m.validateEmail("a@b.com"));
    t.assert(!m.validateEmail("not-an-email"));
    t.assert(!m.validateEmail("a@b"));
  });
  t.test("redirectUrlFor preserves intended route", () => {
    t.equal(m.redirectUrlFor({ origin: "https://x", intendedRoute: "/games/1" }), "https://x/app/#/games/1");
    t.equal(m.redirectUrlFor({ origin: "https://x", intendedRoute: null }), "https://x/app/");
  });
  t.test("parseAuthCallback handles error", () => {
    const r = m.parseAuthCallback("#error=access_denied&error_description=Expired");
    t.assert(!r.ok);
    t.equal(r.error, "Expired");
  });
  t.test("parseAuthCallback handles access_token", () => {
    const r = m.parseAuthCallback("#access_token=abc&type=magiclink");
    t.assert(r.ok);
    t.equal(r.accessToken, "abc");
  });
  t.test("intendedRoute storage round-trips", () => {
    const store = { _:{}, getItem(k){return this._[k]||null}, setItem(k,v){this._[k]=v}, removeItem(k){delete this._[k]} };
    m.saveIntendedRoute(store, "/games/5");
    t.equal(m.intendedRouteFromStorage(store), "/games/5");
    m.clearIntendedRoute(store);
    t.equal(m.intendedRouteFromStorage(store), "/");
  });
}
