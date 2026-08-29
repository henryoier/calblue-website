export function gamesLogicTests(g, t) {
  t.test("spotsLeft counts only registered player/keeper", () => {
    const regs = [
      { status: "registered", participation: "player" },
      { status: "registered", participation: "keeper" },
      { status: "registered", participation: "coach" },
      { status: "waitlisted", participation: "player" },
    ];
    t.equal(g.spotsLeft(10, regs), 8);
    t.equal(g.spotsLeft(null, regs), null);
  });
  t.test("waitlistPosition is 1-based by registered_at", () => {
    const regs = [
      { status: "waitlisted", player_id: "b", registered_at: "2026-01-02" },
      { status: "waitlisted", player_id: "a", registered_at: "2026-01-01" },
    ];
    t.equal(g.waitlistPosition(regs, "a"), 1);
    t.equal(g.waitlistPosition(regs, "b"), 2);
    t.equal(g.waitlistPosition(regs, "c"), null);
  });
  t.test("ownRegistrationState distinguishes registered/waitlisted/not_in", () => {
    const regs = [{ status: "registered", player_id: "x" }];
    t.equal(g.ownRegistrationState(regs, "x").state, "registered");
    t.equal(g.ownRegistrationState(regs, "y").state, "not_in");
    const wl = [{ status: "waitlisted", player_id: "y", registered_at: "2026-01-01" }];
    t.equal(g.ownRegistrationState(wl, "y").waitlistPosition, 1);
  });
  t.test("sortGamesByStart is soonest first", () => {
    const games = [{ start_time: "2026-02-01" }, { start_time: "2026-01-01" }];
    t.equal(g.sortGamesByStart(games)[0].start_time, "2026-01-01");
  });
  t.test("isGatherBeforeKickoff", () => {
    t.assert(g.isGatherBeforeKickoff("2026-01-01T09:00", "2026-01-01T10:00"));
    t.assert(!g.isGatherBeforeKickoff("2026-01-01T11:00", "2026-01-01T10:00"));
  });
  t.test("squadList sorts by jersey number and filters registered", () => {
    const regs = [
      { status: "registered", player_id: "b", jersey_number: 10 },
      { status: "waitlisted", player_id: "c", jersey_number: 1 },
      { status: "registered", player_id: "a", jersey_number: 5 },
    ];
    const s = g.squadList(regs);
    t.equal(s.length, 2);
    t.equal(s[0].playerId, "a");
  });
}
