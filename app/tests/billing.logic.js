export function billingLogicTests(m, t) {
  t.test("resolveFee priority game>competition>schedule>0", () => {
    t.equal(m.resolveFee({game:{fee_override:5}, competition:{default_fee_per_game:10}, feeSchedules:[{amount_per_game:20}]}), 5);
    t.equal(m.resolveFee({game:{}, competition:{default_fee_per_game:10}, feeSchedules:[{amount_per_game:20}]}), 10);
    t.equal(m.resolveFee({game:{}, competition:{}, feeSchedules:[{amount_per_game:20, effective_from:"2020-01-01"}]}), 20);
    t.equal(m.resolveFee({game:{}, competition:{}, feeSchedules:[]}), 0);
  });
  t.test("computeBalance due-paid, voided excluded", () => {
    const r=m.computeBalance([{amount:100},{amount:50,voided_at:"x"}],[{amount:60}]);
    t.equal(r.due, 100); t.equal(r.balance, 40);
  });
  t.test("canClosePeriod refuses unfinalised", () => {
    t.assert(!m.canClosePeriod({gamesInPeriod:[{status:"published"}]}).ok);
    t.assert(m.canClosePeriod({gamesInPeriod:[{status:"completed"}]}).ok);
  });
  t.test("toCsv escapes quotes and commas", () => {
    const csv=m.toCsv([{a:'x,y',b:'\"q\"'}],["a","b"]);
    t.assert(csv.includes('"x,y"'));
    t.assert(csv.includes('"""q"""'));
  });
  t.test("validateCompetition requires name and kind", () => {
    t.assert(m.validateCompetition({}).length>0);
    t.assert(m.validateCompetition({name:"A",kind:"league"}).length===0);
  });
  t.test("standingsFromResults sorts by points then GD", () => {
    const teams=[{id:"t1",name:"A"},{id:"t2",name:"B"}];
    const results=[{home_team_id:"t1",away_team_id:"t2",home_score:3,away_score:1}];
    const s=m.standingsFromResults(results, teams);
    t.equal(s[0].team_id, "t1"); t.equal(s[0].points, 3);
  });
}
