// Billing, payments, quarterly close, CSV export.
// #39 competitions, #40 season roster, #41 fixtures, #43 fees, #44 payments, #45 quarterly close, #46 statement, #47 CSV, #51 audit, #52 clubs, #53-55 tournament/standings.

export function resolveFee({ game, competition, feeSchedules, asOf }) {
  if (game?.fee_override !== null && game?.fee_override !== undefined) return Number(game.fee_override);
  if (competition?.default_fee_per_game !== null && competition?.default_fee_per_game !== undefined) return Number(competition.default_fee_per_game);
  const date = asOf ? new Date(asOf) : new Date();
  const matching = (feeSchedules||[]).filter(s => {
    if (s.game_type && game?.game_type && s.game_type !== game.game_type) return false;
    if (s.effective_from && new Date(s.effective_from) > date) return false;
    if (s.effective_to && new Date(s.effective_to) < date) return false;
    return true;
  }).sort((a,b)=>new Date(b.effective_from)-new Date(a.effective_from));
  return matching.length ? Number(matching[0].amount_per_game) : 0;
}

export function resolveNoShowFee({ game, competition }) {
  if (game?.no_show_fee_override !== null && game?.no_show_fee_override !== undefined) return Number(game.no_show_fee_override);
  if (competition?.default_no_show_fee !== null && competition?.default_no_show_fee !== undefined) return Number(competition.default_no_show_fee);
  return 0;
}

export function computeBalance(charges, payments) {
  const due = (charges||[]).filter(c=>!c.voided_at).reduce((s,c)=>s+Number(c.amount),0);
  const paid = (payments||[]).reduce((s,p)=>s+Number(p.amount),0);
  return { due, paid, balance: due-paid };
}

export function canClosePeriod({ gamesInPeriod }) {
  const unfinalised = (gamesInPeriod||[]).filter(g=>g.status!=="completed" && g.status!=="locked" && g.status!=="cancelled");
  return { ok: unfinalised.length===0, unfinalised };
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const header = columns.map(esc).join(",");
  const lines = (rows||[]).map(r => columns.map(c => esc(r[c])).join(","));
  return [header, ...lines].join("\n");
}

export function validateCompetition(input) {
  const e=[];
  if (!input.name?.trim()) e.push("name required");
  if (!["league","tournament","cup","friendly_series"].includes(input.kind)) e.push("kind invalid");
  if (input.start_date && input.end_date && new Date(input.end_date) < new Date(input.start_date)) e.push("end before start");
  return e;
}

export function validateFeeSchedule(input) {
  const e=[];
  if (!(Number(input.amount_per_game) >= 0)) e.push("amount must be >=0");
  if (!input.effective_from) e.push("effective_from required");
  return e;
}

export function standingsFromResults(results, teams) {
  // results: [{home_team_id, away_team_id, home_score, away_score}]
  const table = {};
  for (const t of (teams||[])) table[t.id] = { team_id:t.id, name:t.name, played:0, won:0, drawn:0, lost:0, gf:0, ga:0, gd:0, points:0 };
  for (const r of (results||[])) {
    const home = table[r.home_team_id]; const away = table[r.away_team_id];
    if (!home || !away) continue;
    home.played++; away.played++;
    home.gf+=r.home_score; home.ga+=r.away_score;
    away.gf+=r.away_score; away.ga+=r.home_score;
    if (r.home_score > r.away_score) { home.won++; home.points+=3; away.lost++; }
    else if (r.home_score < r.away_score) { away.won++; away.points+=3; home.lost++; }
    else { home.drawn++; away.drawn++; home.points+=1; away.points+=1; }
  }
  for (const t of Object.values(table)) t.gd = t.gf - t.ga;
  return Object.values(table).sort((a,b)=> b.points-a.points || b.gd-a.gd || b.gf-a.gf);
}
