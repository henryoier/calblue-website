export function layoutLogicTests(layout, t) {
  const { visibleNavItems } = layout;
  const paths = (state) => visibleNavItems(state).map((item) => item.path).join(",");

  t.test("signed-out navigation exposes only public routes", () => {
    t.equal(paths({ authenticated: false, roles: [] }), "/,/games");
  });

  t.test("signed-in accounts without roles can manage their identity", () => {
    t.equal(paths({ authenticated: true, roles: [] }), "/,/games,/identity");
  });

  t.test("player, coach, and referee roles do not expose administration", () => {
    for (const role of ["player", "coach", "referee"]) {
      t.equal(paths({ authenticated: true, roles: [role] }), "/,/games,/identity");
    }
  });

  t.test("treasurer has no club-wide payments access under released RLS", () => {
    t.equal(
      paths({ authenticated: true, roles: ["treasurer"] }),
      "/,/games,/identity",
    );
  });

  t.test("admin sees every operational destination", () => {
    t.equal(
      paths({ authenticated: true, roles: ["admin"] }),
      "/,/games,/identity,/admin/verify,/admin/payments,/admin/audit,/admin/clubs",
    );
  });

  t.test("developer has no member-data or audit access under released RLS", () => {
    t.equal(
      paths({ authenticated: true, roles: ["developer"] }),
      "/,/games,/identity",
    );
  });

  t.test("malformed or non-exact roles cannot show administration", () => {
    for (const roles of [null, "admin", ["ADMIN"], [" admin "], ["admin", 1], ["organiser"]]) {
      t.equal(paths({ authenticated: true, roles }), "/,/games,/identity");
    }
  });

  t.test("signed-out state ignores stale role claims", () => {
    t.equal(paths({ authenticated: false, roles: ["admin"] }), "/,/games");
  });
}
