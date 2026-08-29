export function sessionLogicTests(session, t) {
  const { parseRoles, hasRole, canAccess, normalizeProfile } = session;
  t.test("parseRoles dedupes and lowercases", () => {
    t.equal(JSON.stringify(parseRoles(["Admin", "player", "ADMIN"])), JSON.stringify(["admin", "player"]));
  });
  t.test("parseRoles accepts JWT shape", () => {
    t.equal(JSON.stringify(parseRoles({ app_metadata: { roles: ["coach"] } })), JSON.stringify(["coach"]));
  });
  t.test("hasRole is case-insensitive", () => {
    t.assert(hasRole(["admin"], "ADMIN"));
  });
  t.test("canAccess with empty required allows all", () => {
    t.assert(canAccess([], []));
    t.assert(canAccess([], null));
  });
  t.test("canAccess requires any listed role", () => {
    t.assert(canAccess(["player"], ["admin", "player"]));
    t.assert(!canAccess(["player"], ["admin"]));
  });
  t.test("normalizeProfile trims and flags empty", () => {
    const p = normalizeProfile({ id: "1", email: "a@b.c", display_name: "  ", roles: ["player"] });
    t.assert(p.isEmpty);
    t.equal(p.displayName, "");
    t.equal(JSON.stringify(p.roles), JSON.stringify(["player"]));
  });
}
