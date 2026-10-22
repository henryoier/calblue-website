// RLS is authoritative. The extra account filters and stale-session checks are defense in depth.
export const BILLING_PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code) => Object.assign(new Error(code), { code });
export function billingCents(value, positive = false) {
  const text = String(value);
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(text)) throw fail("invalid_amount");
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || (positive && (cents <= 0 || cents > 9999999999))) throw fail("invalid_amount");
  return cents;
}
export const billingMoney = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(billingCents(value) / 100);
export const billingDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
function date(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value; }
function text(value, max) { return typeof value === "string" && value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value); }
function id(value) { if (!UUID.test(value || "")) throw fail("invalid_account"); return value; }
function offset(value) { if (!Number.isInteger(value) || value < 0 || value > 1000000) throw fail("load_failed"); return value; }

export function createBillingService({ client, accountId, admin = false, isCurrent = () => true }) {
  const actor = id(accountId);
  let writing = false;
  // Retain an immutable request for retries after uncertain network outcomes.
  const attempts = new Map();
  function live(signal, requireAdmin = false) {
    if (signal?.aborted || isCurrent() !== true) throw fail("stale_request");
    if (requireAdmin && !admin) throw fail("access_denied");
  }
  function target(value = actor) { const result = id(value); if (!admin && result !== actor) throw fail("access_denied"); return result; }
  async function read(query, signal) {
    live(signal);
    let result;
    try { result = await (signal && query.abortSignal ? query.abortSignal(signal) : query); }
    catch { live(signal); throw fail("load_failed"); }
    live(signal);
    if (result?.error?.code === "42501") throw fail("access_denied");
    if (!result || result.error || !Object.prototype.hasOwnProperty.call(result,"data")) throw fail("load_failed");
    return result.data;
  }
  function balance(row, expected) {
    if (!row || row.account_id !== expected) throw fail("load_failed");
    for (const key of ["charges_total","payments_total","balance"]) billingCents(row[key]);
    return { account_id: expected, charges_total: row.charges_total, payments_total: row.payments_total, balance: row.balance };
  }
  async function save(table, payload, signal) {
    live(signal, true); if (writing) throw fail("save_busy");
    const fingerprint = JSON.stringify(payload), key = `${table}:${payload.id}`;
    if (attempts.has(key) && attempts.get(key) !== fingerprint) throw fail("retry_changed");
    attempts.set(key, fingerprint); writing = true;
    try {
      let result;
      try { result = await client.from(table).insert(payload).select(Object.keys(payload).join(",")).single(); }
      catch { throw fail("save_unconfirmed"); }
      live(signal, true);
      if (result?.error?.code === "23505") {
        // Same ID is safe to retry only when its entire original payload matches.
        result = { data: await read(client.from(table).select(Object.keys(payload).join(",")).eq("id",payload.id).maybeSingle(),signal) };
      }
      if (result?.error) throw fail(result.error.code === "42501" ? "access_denied" : "save_unconfirmed");
      const row = result?.data;
      if (!row || Object.keys(payload).some((key) => key === "amount" ? billingCents(row[key]) !== billingCents(payload[key]) : row[key] !== payload[key])) throw fail("save_unconfirmed");
      return row;
    } finally { writing = false; }
  }
  return {
    async summary(selected = actor, { signal } = {}) {
      live(signal); const selectedId = target(selected);
      return balance(await read(client.from("v_account_balance").select("account_id,charges_total,payments_total,balance").eq("account_id",selectedId).maybeSingle(),signal),selectedId);
    },
    async ledger(selected = actor, { page = 0, signal } = {}) {
      live(signal); const selectedId = target(selected), start = offset(page) * BILLING_PAGE_SIZE;
      const rows = await read(client.from("v_account_ledger").select("account_id,entry_date,entry_type,description,amount,direction,source_id").eq("account_id",selectedId).order("entry_date",{ascending:false}).order("source_id",{ascending:false}).range(start,start+BILLING_PAGE_SIZE),signal);
      if (!Array.isArray(rows) || rows.length > BILLING_PAGE_SIZE+1) throw fail("load_failed");
      const clean = rows.map((r) => {
        if (r.account_id !== selectedId || !UUID.test(r.source_id) || !date(r.entry_date) || !["charge","payment"].includes(r.direction) || typeof r.description !== "string" || typeof r.entry_type !== "string") throw fail("load_failed");
        billingCents(r.amount); return r;
      });
      return { rows: clean.slice(0,BILLING_PAGE_SIZE), hasMore: clean.length > BILLING_PAGE_SIZE };
    },
    async accounts({ page = 0, signal } = {}) {
      live(signal,true); const start = offset(page)*BILLING_PAGE_SIZE;
      const profiles = await read(client.from("profiles").select("id,email,display_name").order("email").order("id").range(start,start+BILLING_PAGE_SIZE),signal);
      if (!Array.isArray(profiles) || profiles.length > BILLING_PAGE_SIZE+1 || profiles.some((r) => !UUID.test(r.id) || typeof r.email !== "string" || typeof r.display_name !== "string")) throw fail("load_failed");
      const shown = profiles.slice(0,BILLING_PAGE_SIZE);
      if (!shown.length) return { rows: [], hasMore: false };
      const balances = await read(client.from("v_account_balance").select("account_id,charges_total,payments_total,balance").in("account_id",shown.map((r)=>r.id)),signal);
      if (!Array.isArray(balances) || balances.length !== shown.length || new Set(balances.map((r)=>r.account_id)).size !== shown.length) throw fail("load_failed");
      return { rows: shown.map((p)=>({...p,...balance(balances.find((r)=>r.account_id===p.id),p.id)})), hasMore: profiles.length>BILLING_PAGE_SIZE };
    },
    async players(selected, { signal } = {}) {
      live(signal,true); const selectedId=target(selected);
      const rows=await read(client.from("players").select("id,display_name,legal_name,date_of_birth,preferred_number,verification_status,payer_account_id").eq("payer_account_id",selectedId).order("display_name").order("id").limit(101),signal);
      if (!Array.isArray(rows) || rows.length>100 || rows.some((r)=>!UUID.test(r.id) || r.payer_account_id!==selectedId || typeof r.display_name!=="string")) throw fail("load_failed");
      return rows;
    },
    async createCharge(input, { signal } = {}) {
      live(signal,true); const selectedId=target(input.accountId);
      if (!text(input.description,160) || !date(input.date)) throw fail("invalid_entry");
      const amount=(billingCents(input.amount,true)/100).toFixed(2);
      const player=await read(client.from("players").select("id,payer_account_id").eq("id",id(input.playerId)).eq("payer_account_id",selectedId).maybeSingle(),signal);
      if (!player || player.id!==input.playerId || player.payer_account_id!==selectedId) throw fail("invalid_entry");
      return save("charges",{id:id(input.requestId),player_id:player.id,account_id:selectedId,kind:"season_dues",description:input.description.trim(),amount,charge_date:input.date,source:"manual"},signal);
    },
    async recordReceipt(input, { signal } = {}) {
      live(signal,true); const selectedId=target(input.accountId);
      if (!text(input.reference,160) || !date(input.date) || input.date>billingDate() || input.confirmed!==true) throw fail("invalid_entry");
      return save("payments",{id:id(input.requestId),account_id:selectedId,amount:(billingCents(input.amount,true)/100).toFixed(2),method:"zelle",payment_date:input.date,external_ref:input.reference.trim(),recorded_by:actor,note:"Zelle receipt reviewed by club administrator"},signal);
    },
  };
}
