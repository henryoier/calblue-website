// Synthetic unsigned JWTs are UI fixtures, not usable Supabase credentials.
export function sessionFixture(id = "one", roles = ["player"], extraClaims = {}) {
  const claims = { sub: id, app_metadata: { roles }, ...extraClaims };
  const json = JSON.stringify(claims);
  const bytes = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_match, hex) =>
    String.fromCharCode(parseInt(hex, 16)));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let payload = "";
  let buffer = 0;
  let bits = 0;
  for (const character of bytes) {
    buffer = (buffer << 8) | character.charCodeAt(0);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      payload += alphabet[(buffer >> bits) & 63];
    }
  }
  if (bits) payload += alphabet[(buffer << (6 - bits)) & 63];
  return {
    access_token: "test." + payload + ".unsigned",
    user: {
      id, email: id + "@example.com",
      app_metadata: { roles: ["admin"] },
      user_metadata: { display_name: "Fallback " + id, roles: ["admin"] },
    },
  };
}

export function sessionLogicTests(session, t) {
  const { parseRoles, rolesFromSession, hasRole, canAccess, normalizeProfile } = session;
  const serialized = (value) => JSON.stringify(value);

  t.test("roles preserve exact JWT strings and deduplicate without normalization", () => {
    t.equal(serialized(parseRoles(["Admin", "player", "Admin", " admin "])),
      serialized(["Admin", "player", " admin "]));
    t.assert(!hasRole(["Admin", " admin "], "admin"));
    t.assert(hasRole(["admin"], "admin"));
    t.assert(!hasRole(["admin"], "ADMIN"));
  });

  t.test("malformed or mixed roles fail closed like RLS", () => {
    for (const value of [null, "admin", {}, { roles: ["admin"] }, ["admin", 7],
      ["admin", null], ["admin", {}], ["admin", ["player"]]]) {
      t.equal(serialized(parseRoles(value)), "[]");
      t.assert(!hasRole(value, "admin"));
    }
    t.assert(!hasRole(["admin"], null));
    t.assert(!canAccess(["admin"], "admin"));
  });

  t.test("roles come from the current access token, never mutable user metadata", () => {
    const current = sessionFixture("one", ["player"]);
    t.equal(serialized(rolesFromSession(current)), '["player"]');
    current.user.app_metadata.roles = ["treasurer"];
    current.user.user_metadata.roles = ["admin"];
    t.equal(serialized(rolesFromSession(current)), '["player"]');
    t.equal(serialized(rolesFromSession(sessionFixture("one", ["treasurer"]))), '["treasurer"]');
  });

  t.test("missing or mismatched JWT subjects cannot grant roles", () => {
    for (const sub of [null, "", "someone-else"]) {
      t.equal(serialized(rolesFromSession(sessionFixture("one", ["admin"], { sub }))), "[]");
    }
    const missingUser = sessionFixture("one", ["admin"]);
    delete missingUser.user;
    t.equal(serialized(rolesFromSession(missingUser)), "[]");
  });

  t.test("invalid tokens and malformed role claims fail closed", () => {
    for (const token of [null, "", "not-a-jwt", "test.*.signature", "test.a.signature",
      "test.bnVsbA.signature", "test.W10.signature", "test._w.signature"]) {
      const value = sessionFixture("one", ["admin"]);
      value.access_token = token;
      t.equal(serialized(rolesFromSession(value)), "[]");
    }
    t.equal(serialized(rolesFromSession({ user: { app_metadata: { roles: ["admin"] } } })), "[]");
    t.equal(serialized(rolesFromSession(sessionFixture("one", ["admin", 7]))), "[]");
    t.equal(serialized(rolesFromSession(sessionFixture("one", [], { app_metadata: null }))), "[]");
  });

  t.test("UTF-8 token payloads decode without changing exact role semantics", () => {
    const value = sessionFixture("one", ["player", "ADMIN"], { label: "Café 足球" });
    t.equal(serialized(rolesFromSession(value)), '["player","ADMIN"]');
    t.assert(!session.isAdmin(rolesFromSession(value)));
  });

  t.test("developer and treasurer do not imply administrator", () => {
    t.assert(!session.isAdmin(["developer", "treasurer"]));
    t.assert(session.isDeveloper(["developer"]));
    t.assert(session.isTreasurer(["treasurer"]));
  });

  t.test("canAccess permits public destinations and requires any exact listed role", () => {
    t.assert(canAccess([], []));
    t.assert(canAccess([], null));
    t.assert(canAccess(["player"], ["admin", "player"]));
    t.assert(!canAccess(["player"], ["admin"]));
  });

  t.test("profile normalization is display-only and tolerates malformed metadata", () => {
    const profile = normalizeProfile({ id: "one", email: "one@example.com", display_name: "  ",
      roles: ["admin"], phone: { private: true } });
    t.assert(profile.isEmpty);
    t.equal(profile.displayName, "");
    t.equal(profile.roles, undefined);
    t.equal(profile.phone, "");
    t.equal(normalizeProfile({ display_name: 7 }).displayName, "");
    t.equal(normalizeProfile({ display_name: "  Example  " }).displayName, "Example");
  });
}
