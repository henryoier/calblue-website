export function registrationLogicTests(m, t) {
  t.test("validateGameTimes catches gather after kickoff", () => {
    const e = m.validateGameTimes({gather_time:"2026-01-01T11:00", start_time:"2026-01-01T10:00"});
    t.assert(e.length>0);
  });
  t.test("canRegister pickup allows pending, league requires verified", () => {
    const playerPending={verification_status:"pending"};
    t.assert(m.canRegister({player:playerPending, game:{game_type:"pickup",status:"published"}}).ok);
    t.assert(!m.canRegister({player:playerPending, game:{game_type:"league",status:"published",competition_id:"c1"}, competitionRegistration:{status:"approved"}}).ok);
  });
  t.test("canRegister blocks closed registration", () => {
    const r=m.canRegister({player:{verification_status:"verified"}, game:{game_type:"pickup",status:"published",registration_closes_at:"2000-01-01"}});
    t.assert(!r.ok);
  });
  t.test("promoteWaitlist picks earliest", () => {
    const regs=[{status:"waitlisted",registered_at:"2026-01-02",player_id:"b"},{status:"waitlisted",registered_at:"2026-01-01",player_id:"a"}];
    t.equal(m.promoteWaitlist(regs).player_id, "a");
  });
  t.test("checkIn sets attended and checked_in_by", () => {
    const out=m.checkIn({registration:{status:"registered",player_id:"x"}, attendance:true, checkedBy:"cap1"});
    t.assert(out.attended);
    t.equal(out.checked_in_by, "cap1");
  });
  t.test("finaliseGame converts null attended to no_show and creates charges", () => {
    const {registrations, charges}=m.finaliseGame({game:{id:"g1",status:"completed"}, registrations:[{status:"registered",attended:null,player_id:"p1"},{status:"registered",attended:true,player_id:"p2"}]});
    t.equal(registrations[0].status, "no_show");
    t.equal(charges.length, 2);
  });
  t.test("isPickup true only for pickup with no competition", () => {
    t.assert(m.isPickup({game_type:"pickup",competition_id:null}));
    t.assert(!m.isPickup({game_type:"pickup",competition_id:"c"}));
  });
}
