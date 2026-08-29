export function publicRosterLogicTests(m, t) {
  t.test("filterPublicRoster only opt-in verified", () => {
    const rows = [
      { display_name: "A", is_public: true, verification_status: "verified" },
      { display_name: "B", is_public: true, verification_status: "pending" },
      { display_name: "C", is_public: false, verification_status: "verified" },
    ];
    t.equal(m.filterPublicRoster(rows).length, 1);
  });
  t.test("sortRoster alphabetical", () => {
    t.equal(m.sortRoster([{display_name:"Zoe"},{display_name:"Alex"}])[0].display_name, "Alex");
  });
  t.test("gracefulDegradation uses static when unreachable", () => {
    const r = m.gracefulDegradation({ dbReachable: false, rows: [], staticMarkup: [{name:"Static"}] });
    t.equal(r.source, "static");
  });
  t.test("gracefulDegradation uses DB when reachable", () => {
    const r = m.gracefulDegradation({ dbReachable: true, rows: [{display_name:"A", is_public:true, verification_status:"verified"}] });
    t.equal(r.source, "database");
    t.equal(r.cards[0].name, "A");
  });
}
