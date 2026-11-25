import { html, mount } from "../js/dom.js";
import { billingMoney, billingDate } from "../js/billing.js";
import { DEFAULT_PAYMENT_SETTINGS } from "../../club-office/model.js";

export function billingView(mainEl, { service, accountId, admin = false, context }) {
  let disposed=false, generation=0, accountPage=0, entryPage=0, selected=admin?null:{id:accountId,display_name:"My account"};
  const current=()=>!disposed && !context.signal.aborted && context.isCurrent();
  const errorText=(error)=>error.code==="access_denied"?"Your account does not have access to this information.":"Could not load account records. Retry or contact the club administrator.";
  const query=(selector)=>mainEl.querySelector(selector);
  const bind=(selector,handler)=>{ const el=query(selector); if(el) el.addEventListener("click",handler); };
  async function load() {
    const version=++generation; if(!current()) return;
    mount(mainEl,html`<section class="app-billing"><p role="status">Loading ${admin?"club":"your"} records…</p></section>`);
    try {
      if(!selected) {
        const result=await service.accounts({page:accountPage,signal:context.signal}); if(!current()||version!==generation)return;
        mount(mainEl,html`<section class="app-billing"><p class="app-eyebrow">Administrator / Private</p><h1>Club accounts</h1><p>Player accounts and their balances. Select an account to review its players, charges and receipts.</p><p class="app-muted">These are online records. The separate encrypted local vault is not automatically uploaded.</p><div class="app-billing-table"><table><thead><tr><th>Account</th><th>Balance</th><th>Action</th></tr></thead><tbody>${result.rows.map((r)=>html`<tr><td><strong>${r.display_name||r.email}</strong><br>${r.email}</td><td>${billingMoney(r.balance)}</td><td><button class="app-button" data-account="${r.id}">View account</button></td></tr>`)}</tbody></table></div>${!result.rows.length?html`<p>No registered accounts on this page.</p>`:null}<div class="app-billing-actions"><button class="app-button" data-prev>Previous accounts</button><button class="app-button" data-next>Next accounts</button></div></section>`);
        query("[data-prev]").disabled=accountPage===0; query("[data-next]").disabled=!result.hasMore;
        bind("[data-prev]",()=>{accountPage--;void load();}); bind("[data-next]",()=>{accountPage++;void load();});
        mainEl.querySelectorAll("[data-account]").forEach((button)=>button.addEventListener("click",()=>{selected=result.rows.find((r)=>r.id===button.dataset.account);entryPage=0;void load();})); return;
      }
      const [summary,ledger,players]=await Promise.all([service.summary(selected.id,{signal:context.signal}),service.ledger(selected.id,{page:entryPage,signal:context.signal}),admin?service.players(selected.id,{signal:context.signal}):Promise.resolve([])]);
      if(!current()||version!==generation)return;
      mount(mainEl,html`<section class="app-billing"><p class="app-eyebrow">${admin?"Administrator / Private":"Your account / Private"}</p><h1>${admin?selected.display_name||selected.email:"My bills"}</h1>${admin?html`<p>${selected.email}</p><button class="app-button" data-accounts>← Club accounts</button>`:null}<div class="app-billing-summary"><div><span>Charges</span><strong>${billingMoney(summary.charges_total)}</strong></div><div><span>Payments</span><strong>${billingMoney(summary.payments_total)}</strong></div><div><span>Balance</span><strong>${billingMoney(summary.balance)}</strong></div></div><p class="app-muted">A negative balance is account credit. A reported transfer is not an automatically verified receipt.</p>${!admin&&Number(summary.balance)>0?html`<div class="app-billing-panel"><h2>Pay with Zelle</h2><p>Tag: <strong>${DEFAULT_PAYMENT_SETTINGS.zelleRecipient}</strong><br>Recipient: <strong>${DEFAULT_PAYMENT_SETTINGS.zelleName}</strong></p><p>Check the recipient name before transferring. Include your name and the charge description in the memo, then send your confirmation to the team manager. The manager will check Chase before recording the receipt.</p></div>`:null}<h2>Statement</h2><div class="app-billing-table"><table><thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Balance change</th></tr></thead><tbody>${ledger.rows.map((r)=>html`<tr><td>${r.entry_date}</td><td>${r.description}</td><td>${r.direction} · ${r.entry_type}</td><td>${billingMoney(r.amount)}</td></tr>`)}</tbody></table></div>${!ledger.rows.length?html`<p>No statement entries on this page.</p>`:null}<div class="app-billing-actions"><button class="app-button" data-older>Older entries</button><button class="app-button" data-newer>Newer entries</button><button class="app-button" data-refresh>Refresh</button></div>${admin?html`<div class="app-billing-panel"><h2>Players billed to this account</h2>${players.map((p)=>html`<p><strong>${p.display_name}</strong> · ${p.verification_status}<br>Legal name: ${p.legal_name||"Not provided"} · DOB: ${p.date_of_birth||"Not provided"} · Jersey: ${p.preferred_number??"—"}</p>`)}${!players.length?html`<p>No linked player identity. The member can create one in My identity.</p>`:null}</div><div class="app-billing-panel"><h2>Add a charge</h2><form data-charge><label>Player<select name="playerId" required><option value="">Choose player</option>${players.map((p)=>html`<option value="${p.id}">${p.display_name}</option>`)}</select></label><label>Description<input name="description" required maxlength="160" placeholder="Fall season dues"></label><label>Amount (USD)<input name="amount" required inputmode="decimal"></label><label>Charge date<input name="date" type="date" value="${billingDate()}" required></label><label class="app-billing-check"><input type="checkbox" name="confirmed" required>I checked this player, charge and amount.</label><button class="app-button" type="submit">Save charge</button><p role="status" data-write-status></p></form></div><div class="app-billing-panel"><h2>Record a reviewed Zelle receipt</h2><p>This is a manual entry after checking Chase. It does not access or verify the bank account automatically.</p><form data-payment><label>Amount received (USD)<input name="amount" required inputmode="decimal"></label><label>Receipt date<input name="date" type="date" value="${billingDate()}" max="${billingDate()}" required></label><label>Chase transaction reference<input name="reference" required maxlength="160"></label><label class="app-billing-check"><input type="checkbox" name="confirmed" required>I checked Chase, the payer and amount, and confirmed this receipt has not already been recorded.</label><button class="app-button" type="submit">Save reviewed receipt</button><p role="status" data-write-status></p></form></div>`:null}<p class="app-muted">Private records are restricted by your signed-in account. Sign out on shared devices.</p></section>`);
      bind("[data-accounts]",()=>{selected=null;entryPage=0;void load();}); bind("[data-refresh]",()=>void load());
      query("[data-older]").disabled=!ledger.hasMore; query("[data-newer]").disabled=entryPage===0;
      bind("[data-older]",()=>{entryPage++;void load();});bind("[data-newer]",()=>{entryPage--;void load();});
      if(admin) { wireWrite("[data-charge]","createCharge"); wireWrite("[data-payment]","recordReceipt"); }
    } catch(error) {
      if(!current()||version!==generation)return;
      mount(mainEl,html`<section class="app-billing"><h1>${admin?"Club accounts":"My bills"}</h1><p class="app-error" role="alert">${errorText(error)}</p><button class="app-button" data-retry>Retry</button></section>`);bind("[data-retry]",()=>void load());
    }
  }
  function wireWrite(selector,method) {
    const form=query(selector), requestId=crypto.randomUUID(); let frozen=null,busy=false;
    form.addEventListener("submit",async(event)=>{
      event.preventDefault(); if(!current()||busy)return;
      if(!form.reportValidity())return; busy=true;
      const button=form.querySelector("button"),status=form.querySelector("[data-write-status]");button.disabled=true;
      frozen ||= {...Object.fromEntries(new FormData(form)),accountId:selected.id,requestId,confirmed:true};
      form.querySelectorAll("input,select").forEach((el)=>el.disabled=true);
      status.textContent="Saving…";
      try { await service[method](frozen,{signal:context.signal});if(!current())return;entryPage=0;await load(); }
      catch(error) { if(!current()||!mainEl.contains(form))return;status.textContent=error.code==="access_denied"?"Access denied. Refresh your access.":error.code==="invalid_entry"||error.code==="invalid_amount"?"Invalid entry. Refresh this page to correct the form.":"Save not confirmed. Retry this same entry; its request ID prevents a second copy. Do not create a new entry before checking the statement.";button.textContent="Retry same entry";button.disabled=error.code==="access_denied"; }
      finally {busy=false;}
    });
  }
  const cleanup=()=>{if(disposed)return;disposed=true;generation++;mainEl.replaceChildren();};
  context.signal.addEventListener("abort",cleanup,{once:true});void load();
  return ()=>{context.signal.removeEventListener("abort",cleanup);cleanup();};
}
