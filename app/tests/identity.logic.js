export function identityLogicTests(m, t) {
  t.test("validateIdentity rejects empty and bad number", () => {
    t.assert(m.validateIdentity({}).length > 0);
    t.assert(m.validateIdentity({display_name:"A", preferred_number:100}).length > 0);
    t.assert(m.validateIdentity({display_name:"A", preferred_number:10}).length === 0);
  });
  t.test("validateIdentity rejects future DOB", () => {
    const future = new Date(Date.now()+86400000).toISOString().slice(0,10);
    t.assert(m.validateIdentity({display_name:"A", date_of_birth:future}).length > 0);
  });
  t.test("canCreateOwnIdentity only if none", () => {
    t.assert(m.canCreateOwnIdentity({accountId:"1", existingIdentities:[]}));
    t.assert(!m.canCreateOwnIdentity({accountId:"1", existingIdentities:[{account_id:"1"}]}));
  });
  t.test("canEditVerification only admin", () => {
    t.assert(m.canEditVerification({roles:["admin"]}));
    t.assert(!m.canEditVerification({roles:["player"]}));
  });
  t.test("filterPending sorts newest first", () => {
    const rows=[{verification_status:"pending",created_at:"2026-01-01"},{verification_status:"pending",created_at:"2026-01-03"}];
    t.equal(m.filterPending(rows)[0].created_at, "2026-01-03");
  });
  t.test("applyVerificationDecision sets decided_by/at", () => {
    const out=m.applyVerificationDecision({id:"1"},{decision:"verified",note:"ok",decidedBy:"admin1"});
    t.equal(out.verification_status, "verified");
    t.equal(out.decided_by, "admin1");
    t.assert(out.decided_at);
  });
}
