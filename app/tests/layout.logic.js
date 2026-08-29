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

  t.test("treasurer sees payments but not admin-only screens", () => {
    t.equal(
      paths({ authenticated: true, roles: ["treasurer"] }),
      "/,/games,/identity,/admin/payments",
    );
  });

  t.test("admin sees every operational destination", () => {
    t.equal(
      paths({ authenticated: true, roles: ["admin"] }),
      "/,/games,/identity,/admin/verify,/admin/payments,/admin/audit,/admin/clubs",
    );
  });

  t.test("developer sees audit but not unrelated admin screens", () => {
    t.equal(
      paths({ authenticated: true, roles: ["developer"] }),
      "/,/games,/identity,/admin/audit",
    );
  });
}
