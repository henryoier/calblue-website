import { newKeys, passwordKey, vaultEnvelope, unlockEnvelope, openRegistration, openPaymentReport, fingerprint, validatePublicKey } from "./crypto.js";
import { readVault, writeVault } from "./storage.js";
import { DEFAULT_PAYMENT_SETTINGS, FIELDS, today, emptyState, validateState, validatePlayer, addPlayer, updatePlayer, fullName, audit, cents, money, balance, createInvoice, recordPayment, voidPayment, parseCSV, parseOFX, csv, importTransactions, candidateInvoices, reminder, isReceipt, paymentSettings, paymentRequest, addPaymentReport, paymentReportStatus } from "./model.js";
import { $, askConfirm, html, mount, notify, download, readFile, playerForm, configurePlayerForm, playerFormData } from "./shared.js";

let state = null, key = null, salt = null, revision = null, stored = null, page = "players", busy = false, lastActivity = Date.now(), generation = 0;
const main = $("#main");
const sections = [["players", "Players"], ["billing", "Dues & reminders"], ["bank", "Match payments"], ["exports", "Forms & exports"], ["settings", "Backup & settings"]];
const playerName = (id) => fullName(state.players.find((p) => p.id === id));
const openInvoices = () => state.invoices.filter((i) => balance(state, i) > 0);

async function commit(change) {
  if (busy || !state) throw new Error("Please wait for the current save to finish.");
  busy = true;
  const epoch = generation;
  try {
    const next = structuredClone(state);
    const result = await change(next);
    const envelope = await vaultEnvelope(next, key, salt);
    if (epoch !== generation) throw new Error("Vault locked before saving. Unlock and retry.");
    const nextRevision = await writeVault(envelope, revision);
    if (epoch === generation) { revision = nextRevision; state = next; stored = { revision, envelope }; }
    return result;
  } finally { busy = false; }
}
function action(selector, fn) {
  const element = $(selector); if (!element) return;
  element.addEventListener("click", async (event) => {
    event.preventDefault(); if (element.disabled) return; element.disabled = true;
    try { await fn(event); } catch (error) { notify(error.message, true); }
    finally { element.disabled = false; }
  });
}
function submit(selector, fn) {
  $(selector).addEventListener("submit", async (event) => {
    event.preventDefault(); const button = $("button[type=submit]", event.target); if (button.disabled) return;
    button.disabled = true;
    try { await fn(new FormData(event.target)); }
    catch (error) { if ($("#form-error")) $("#form-error").textContent = error.message; notify(error.message, true); }
    finally { button.disabled = false; }
  });
}
function lock() {
  generation++; state = key = salt = null;
  document.dispatchEvent(new Event("vault-lock"));
  main.replaceChildren(); $("#nav").replaceChildren(); $("#session").replaceChildren();
  $("#notice").textContent = "";
  showLocked().catch((error) => notify(error.message, true));
}
function render() {
  if (!state) return;
  mount($("#session"), html`<span class="session-note">Saved encrypted on this browser</span><button id="lock">Lock</button>`);
  mount($("#nav"), html`${sections.map(([id, label]) => html`<button data-page="${id}">${label}</button>`)}<p class="nav-note">This vault is separate from the online member account. Export a backup after each session.</p>`);
  document.querySelectorAll("[data-page]").forEach((button) => {
    if (button.dataset.page === page) button.setAttribute("aria-current", "page");
    button.onclick = () => { page = button.dataset.page; render(); main.focus(); };
  });
  action("#lock", lock);
  ({ players: showPlayers, billing: showBilling, bank: showBank, exports: showExports, settings: showSettings })[page]();
}
async function showLocked() {
  stored = await readVault(); revision = stored?.revision || null;
  mount($("#nav"), html``); mount($("#session"), html``);
  mount(main, html`<section class="welcome"><p class="eyebrow">CalBlue FC / Club office</p><h1>The team, organized.</h1><p class="intro">Player details, season dues and registration forms. In one private vault, on your device.</p><div class="panel"><div class="stripe"></div><h2>${stored ? "Unlock your club vault" : "Create your club vault"}</h2><p class="muted">${stored ? "Use your vault passphrase. Your online member password is separate." : "Choose a long, unique passphrase. There is no password reset: keep it in your password manager, together with an encrypted backup."}</p><form id="unlock-form"><div class="field"><label for="password">Vault passphrase · at least 14 characters</label><input type="password" id="password" name="password" minlength="14" required autocomplete="${stored ? "current-password" : "new-password"}"></div>${!stored ? html`<div class="field"><label for="confirm-password">Repeat passphrase</label><input type="password" id="confirm-password" name="confirm" minlength="14" required autocomplete="new-password"></div>` : null}<p id="form-error" class="error" role="alert"></p><div class="actions"><button class="primary" type="submit">${stored ? "Unlock vault" : "Create encrypted vault"}</button></div></form></div><div class="panel"><h3>Restore an encrypted backup</h3><p class="small muted">${stored ? "Restoring replaces this browser’s vault. Unlock and export its latest backup first." : "Moving computers? Choose your .cbvault backup and enter its original passphrase above."}</p><label for="restore">Encrypted backup file</label><input id="restore" type="file" accept=".cbvault,application/json"><div class="actions"><button id="restore-button">Restore backup</button></div></div><p class="small muted">Only encrypted data is saved in browser storage. Clearing browser data removes this copy. The office locks after 10 minutes of inactivity. Use one dedicated browser profile for club administration.</p></section>`);
  submit("#unlock-form", async (form) => {
    const password = form.get("password");
    if (stored) {
      const unlocked = await unlockEnvelope(stored.envelope, password);
      state = validateState(unlocked.state); key = unlocked.key; salt = unlocked.salt;
    } else {
      if (password !== form.get("confirm")) throw new Error("Passphrases do not match.");
      const nextSalt = crypto.getRandomValues(new Uint8Array(16));
      const nextKey = await passwordKey(password, nextSalt);
      const nextState = emptyState(await newKeys());
      const envelope = await vaultEnvelope(nextState, nextKey, nextSalt);
      revision = await writeVault(envelope, null); stored = { revision, envelope };
      state = nextState; key = nextKey; salt = nextSalt;
      download("calblue-initial-backup.cbvault", JSON.stringify(envelope));
    }
    generation++; lastActivity = Date.now(); render(); notify("Vault unlocked. Remember to export a new backup after changes.");
  });
  action("#restore-button", async () => {
    const file = $("#restore").files[0];
    const envelope = JSON.parse(await readFile(file, 256 * 1024 * 1024));
    const unlocked = await unlockEnvelope(envelope, $("#password").value);
    validateState(unlocked.state);
    if (stored && !await askConfirm("Replace this browser’s vault with this backup? Any changes since the backup will be lost. Cancel if you have not saved the current vault first.")) return;
    revision = await writeVault(envelope, revision); stored = { revision, envelope };
    state = unlocked.state; key = unlocked.key; salt = unlocked.salt; generation++; lastActivity = Date.now(); render(); notify("Backup restored and unlocked.");
  });
}

function showPlayers() {
  const active = state.players.filter((p) => p.active);
  mount(main, html`<p class="eyebrow">Squad administration</p><div class="toolbar"><h1>Players</h1><button id="invite">Registration link</button><button class="primary" id="add-player">Add player</button></div><div class="metrics"><div class="metric"><strong>${active.length}</strong><span>Active players</span></div><div class="metric"><strong>${active.filter((p) => !p.reviewed).length}</strong><span>Need profile review</span></div><div class="metric"><strong>${money(openInvoices().reduce((sum, i) => sum + balance(state, i), 0))}</strong><span>Outstanding dues</span></div></div><div class="panel"><div class="toolbar"><label for="search">Find a player</label><input type="search" id="search" placeholder="Name, email or player ID"><label class="check"><input type="checkbox" id="archived">Include archived</label></div><div id="players-list"></div></div><div class="panel"><h2>Import a player registration</h2><p class="small muted">Choose the encrypted .cbreg file sent by the player. Imported profiles need your review. Existing records are never overwritten.</p><label for="registration-file">Registration file</label><input type="file" id="registration-file" accept=".cbreg,application/json"><div class="actions"><button id="import-registration">Decrypt & import</button></div></div>`);
  const list = () => {
    const search = $("#search").value.toLowerCase();
    const players = state.players.filter((p) => ($("#archived").checked || p.active) && `${fullName(p)} ${p.preferredName} ${p.email} ${p.clubId}`.toLowerCase().includes(search));
    mount($("#players-list"), players.length ? html`<div class="table-wrap"><table><thead><tr><th>Player</th><th>Contact</th><th>Profile</th><th>Balance</th><th>Action</th></tr></thead><tbody>${players.map((p) => html`<tr><td><strong>${fullName(p)}</strong><span class="small muted">${p.clubId} · ${p.preferredName}${p.jersey ? ` · #${p.jersey}` : ""}${p.active ? "" : " · Archived"}</span></td><td>${p.email}<span class="small muted">${p.phone || "No phone"}</span></td><td><span class="tag ${p.reviewed ? "good" : "warn"}">${p.reviewed ? "Profile reviewed" : "Needs review"}</span></td><td>${money(state.invoices.filter((i) => i.playerId === p.id).reduce((sum, i) => sum + balance(state, i), 0))}</td><td><button data-player="${p.id}">Open profile</button></td></tr>`)}</tbody></table></div>` : html`<div class="empty">${state.players.length ? "No matching players." : "Your squad starts here. Add a player or share a registration link, then import the returned file."}</div>`);
    document.querySelectorAll("[data-player]").forEach((button) => button.onclick = () => editPlayer(button.dataset.player));
  };
  $("#search").oninput = list; $("#archived").onchange = list; list();
  action("#add-player", () => editPlayer()); action("#invite", showInvite);
  action("#import-registration", async () => {
    const epoch = generation;
    const box = JSON.parse(await readFile($("#registration-file").files[0]));
    const player = await openRegistration(box, state.keys);
    if (epoch !== generation) throw new Error("Vault locked. Unlock and retry the import.");
    editPlayer(undefined, validatePlayer(player)); notify("Registration decrypted. Check the join year and details, then save to assign a club ID.");
  });
}
function editPlayer(id, draft = {}) {
  const player = state.players.find((p) => p.id === id) || draft;
  mount(main, html`<div class="toolbar no-print"><button id="back">← Players</button></div><p class="eyebrow">Private player profile</p><div class="identity-head">${player.photo ? html`<img class="photo" src="${player.photo}" alt="Player headshot">` : null}<div><h1>${id ? fullName(player) : "Add a player"}</h1>${id ? html`<p class="code">${player.clubId} · Joined ${player.joinYear}</p>` : null}${id ? html`<span class="tag ${player.reviewed ? "good" : "warn"}">${player.reviewed ? "Profile reviewed" : "Needs review"}</span>` : null}</div></div><div class="panel">${playerForm(player, true)}</div>${id ? html`<div class="panel no-print"><h2>Manage this profile</h2><p class="small muted">Profile review records an administrator check; it is not legal identity verification or league eligibility approval.</p><div class="actions"><button id="review">Mark profile reviewed</button><button id="print">Print player form / Save PDF</button><button id="archive">${player.active ? "Archive player" : "Reactivate player"}</button><button class="danger" id="delete">Delete personal data</button></div></div>` : null}`);
  configurePlayerForm(player); action("#back", render);
  submit("#player-form", async () => {
    const epoch = generation; const input = await playerFormData(player);
    if (epoch !== generation) throw new Error("Vault locked. Unlock and retry.");
    let nextId = id;
    await commit((next) => { if (id) updatePlayer(next, id, input); else nextId = addPlayer(next, input).id; });
    editPlayer(nextId); notify("Player saved in the encrypted vault.");
  });
  action("#review", async () => { await commit((next) => { next.players.find((p) => p.id === id).reviewed = true; audit(next, "profile-reviewed", id); }); editPlayer(id); notify("Profile marked reviewed."); });
  action("#archive", async () => { await commit((next) => { const p = next.players.find((p) => p.id === id); p.active = !p.active; audit(next, p.active ? "player-reactivated" : "player-archived", id); }); render(); });
  action("#delete", async () => {
    if (state.invoices.some((i) => i.playerId === id)) throw new Error("This player has financial records. Archive the profile, or clear optional contact fields in the form. Full deletion with financial retention needs a separate policy.");
    if (!await askConfirm("Permanently delete this player’s profile and images from this vault? Old backup files still contain earlier copies.")) return;
    await commit((next) => { next.players = next.players.filter((p) => p.id !== id); audit(next, "player-deleted", id); }); render(); notify("Player deleted from the current vault. Review retained backups separately.");
  });
  action("#print", () => printPlayer(player));
}
function printPlayer(player) {
  const publicFields = ["firstName", "lastName", "preferredName", "email", "phone", "dob", "address", "emergencyName", "emergencyPhone", "guardian", "clubId", "joinYear", "leagueId", "jersey"];
  mount(main, html`<div class="toolbar no-print"><button id="back-profile">← Profile</button><button id="print-now" class="primary">Print / Save PDF</button><span class="small muted">Contains private information. Only the saved player profile and headshot are included.</span></div><p class="eyebrow">CalBlue FC / Player registration record</p><h1>${fullName(player)}</h1><div class="panel">${player.photo ? html`<img class="photo" src="${player.photo}" alt="Player headshot">` : null}<dl class="grid">${publicFields.map((field) => html`<div><dt class="small muted">${FIELDS[field]}</dt><dd>${player[field] || "—"}</dd></div>`)}</dl><p class="small">Prepared ${today()} · Profile ${player.reviewed ? "reviewed by club administrator" : "awaiting review"} · Not a league registration confirmation.</p></div>`);
  action("#back-profile", () => editPlayer(player.id)); action("#print-now", () => window.print());
}
async function showInvite() {
  const publicKey = validatePublicKey(state.keys.publicKey);
  const url = new URL("register.html", location.href); url.hash = new URLSearchParams({ club: JSON.stringify(publicKey) }).toString();
  const keyId = (await fingerprint(publicKey)).slice(0, 16);
  if (!state) return;
  mount(main, html`<p class="eyebrow">Bring your squad in</p><h1>Player registration</h1><div class="panel"><ol class="checklist"><li>Share this link and club key with the player.</li><li>The player fills the form and downloads an encrypted .cbreg file.</li><li>They send you that file through your usual team channel.</li><li>Import it in Players, then review the profile.</li></ol><p class="small muted">Club key: <strong class="code">${keyId}</strong></p><label for="invite-link">Registration link</label><textarea id="invite-link" readonly></textarea><p class="small muted">This link contains a public encryption key only. It cannot open the vault or any registration.</p><div class="actions"><button id="copy-link">Copy link</button><button id="back-players">Back to players</button></div>${["localhost", "127.0.0.1"].includes(location.hostname) ? html`<div class="notice-box">This is a local preview link. To share with teammates, publish the program files over HTTPS and generate the link there after restoring your vault. Publishing the form does not publish the database. You can also send teammates a local copy of the program plus the public link fragment.</div>` : null}</div>`);
  $("#invite-link").value = url.href;
  action("#copy-link", async () => { await navigator.clipboard.writeText(url.href); notify("Registration link copied."); }); action("#back-players", render);
}

function showBilling() {
  const invoices = [...state.invoices].reverse();
  mount(main, html`<p class="eyebrow">Season finances / USD</p><div class="toolbar"><h1>Dues & reminders</h1><button id="new-invoice" class="primary">Create dues</button></div><p class="intro muted">Track what is owed, record payments and prepare individual reminders. Only recorded payments reduce a balance.</p><div class="panel"><div class="table-wrap"><table><thead><tr><th>Player / charge</th><th>Due</th><th>Outstanding</th><th>Status</th><th>Action</th></tr></thead><tbody>${invoices.map((i) => html`<tr><td><strong>${playerName(i.playerId)}</strong><span class="small muted">${i.title}</span></td><td>${i.due}</td><td>${money(balance(state, i))}<span class="small muted">of ${money(i.amount)}</span></td><td><span class="tag ${balance(state, i) <= 0 ? "good" : i.due < today() ? "warn" : ""}">${i.voided ? "Voided" : balance(state, i) <= 0 ? "Paid" : (state.paymentReports || []).some((r) => r.invoiceId === i.id && paymentReportStatus(state, r) === "Awaiting receipt review") ? "Reported · review" : i.due < today() ? "Overdue" : "Open"}</span></td><td><button data-invoice="${i.id}">Manage</button></td></tr>`)}</tbody></table></div>${!invoices.length ? html`<p class="empty">Create a season fee, tournament fee or other charge for one player or all active players.</p>` : null}</div>`);
  action("#new-invoice", invoiceForm);
  document.querySelectorAll("[data-invoice]").forEach((button) => button.onclick = () => showInvoice(button.dataset.invoice));
}
function invoiceForm() {
  const active = state.players.filter((p) => p.active);
  mount(main, html`<p class="eyebrow">New charge</p><h1>Create dues</h1><div class="panel"><form id="invoice-form"><div class="grid"><div class="field"><label for="playerId">Charge to</label><select id="playerId" name="playerId"><option value="">Choose player(s)</option><option value="all">All active players (${active.length})</option>${active.map((p) => html`<option value="${p.id}">${fullName(p)}</option>`)}</select></div><div class="field"><label for="title">Title</label><input id="title" name="title" maxlength="160" required placeholder="Fall 2026 team dues"></div><div class="field"><label for="amount">Amount per player (USD)</label><input id="amount" name="amount" inputmode="decimal" required placeholder="100.00"></div><div class="field"><label for="due">Due date</label><input id="due" name="due" type="date" required value="${today()}"></div></div><p id="form-error" class="error" role="alert"></p><div class="actions"><button type="submit" class="primary">Create charge(s)</button><button type="button" id="cancel">Cancel</button></div></form></div>`);
  action("#cancel", render);
  submit("#invoice-form", async (form) => {
    const ids = form.get("playerId") === "all" ? active.map((p) => p.id) : [form.get("playerId")];
    if (!ids.length || !ids[0]) throw new Error("Choose at least one player.");
    const amount = cents(form.get("amount"));
    if (!await askConfirm(`Create ${ids.length} charge(s) of ${money(amount)} each? Total ${money(amount * ids.length)}. This does not send an email.`)) return;
    await commit((next) => { for (const playerId of ids) createInvoice(next, { playerId, title: form.get("title"), amount, due: form.get("due") }); });
    render(); notify(`${ids.length} charge(s) created.`);
  });
}
function showInvoice(id) {
  const invoice = state.invoices.find((i) => i.id === id), outstanding = balance(state, invoice);
  const payments = state.payments.filter((p) => p.invoiceId === id);
  mount(main, html`<div class="toolbar"><button id="back-billing">← Dues</button></div><p class="eyebrow">${playerName(invoice.playerId)}</p><h1>${invoice.title}</h1><p>${money(outstanding)} outstanding · Due ${invoice.due}</p><p class="small code">Payment reference: ${invoice.reference}</p><div id="payment-reports"></div>${outstanding > 0 ? html`<div class="panel"><h2>Record a payment</h2><p class="small muted">Use bank matching for imported transactions, or record a payment you have checked yourself. A manual entry is labelled as manual.</p><form id="payment-form"><div class="grid"><div class="field"><label for="paid-amount">Amount received (USD)</label><input id="paid-amount" name="amount" required inputmode="decimal" value="${(outstanding / 100).toFixed(2)}"></div><div class="field"><label for="note">Reference / review note</label><input id="note" name="note" maxlength="500" required placeholder="Cash received, or payment reference"></div></div><div class="actions"><button type="submit">Record manual payment</button><button type="button" id="payment-link">Payment instructions & report link</button><button type="button" id="reminder" class="primary">Preview reminder email</button></div></form></div>` : null}<div class="panel"><h2>Payment history</h2>${payments.length ? payments.map((p) => html`<p><strong>${money(p.amount)}</strong> · ${p.method === "bank-reviewed" ? "Bank export · reviewed" : p.method === "venmo-reviewed" ? "Venmo export · reviewed" : "Manual"} · ${p.createdAt.slice(0, 10)} · ${p.voided ? "Reversed" : "Recorded"}<br><span class="small muted">${p.note}</span>${!p.voided ? html` <button data-reverse="${p.id}">Reverse</button>` : null}</p>`) : html`<p class="muted">No recorded payments.</p>`}${!invoice.voided && !payments.some((p) => !p.voided) ? html`<button id="void" class="danger">Void this charge</button>` : null}</div>`);
  renderPaymentReports(id);
  action("#payment-link", () => showPaymentLink(id));
  action("#back-billing", render); action("#reminder", () => showReminder(id));
  if ($("#payment-form")) submit("#payment-form", async (form) => { await commit((next) => recordPayment(next, { invoiceId: id, amount: cents(form.get("amount")), note: form.get("note") })); showInvoice(id); notify("Manual payment recorded."); });
  document.querySelectorAll("[data-reverse]").forEach((button) => action(`[data-reverse="${button.dataset.reverse}"]`, async () => { if (!await askConfirm("Reverse this payment? The invoice balance will increase and any bank transaction will be available to match again.")) return; await commit((next) => voidPayment(next, button.dataset.reverse)); showInvoice(id); }));
  action("#void", async () => { if (!await askConfirm("Void this charge? The record will remain in the audit history.")) return; await commit((next) => { next.invoices.find((i) => i.id === id).voided = true; audit(next, "invoice-voided", id); }); showInvoice(id); });
}
function showReminder(id) {
  const message = reminder(state, id);
  mount(main, html`<p class="eyebrow">Review before sending</p><h1>Payment reminder</h1><div class="panel"><p><strong>To:</strong> ${message.to}</p><p><strong>Subject:</strong> ${message.subject}</p><pre>${message.body}</pre><p class="small muted">Open this message in your email app, then send it there. Opening a draft is not delivery. Use the team mailbox as the sender.</p><div class="actions"><a class="button primary" id="open-mail">Open email draft</a><button id="copy-email">Copy email text</button><button id="back-invoice">Back to charge</button></div></div>`);
  $("#open-mail").href = `mailto:${encodeURIComponent(message.to)}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.body)}`;
  action("#copy-email", async () => { await navigator.clipboard.writeText(`To: ${message.to}\nSubject: ${message.subject}\n\n${message.body}`); notify("Email copied. It has not been sent."); }); action("#back-invoice", () => showInvoice(id));
}

function showBank() {
  const hasVenmo = Boolean(state.settings.venmoUsername || state.transactions.some((t) => t.source === "venmo"));
  const available = state.transactions.filter((t) => isReceipt(t) && !state.payments.some((p) => !p.voided && p.transactionId === t.id));
  mount(main, html`<p class="eyebrow">Reconcile incoming payments</p><h1>Match payments</h1><p class="intro muted">Import a ${hasVenmo ? "Chase or Venmo" : "Chase"} statement, then confirm each match against a player’s charge. Matching by amount alone is a suggestion, not proof of who paid.</p><div class="notice-box">Live ${hasVenmo ? "Chase / Venmo connections" : "Chase connection"}: not configured. This page works with locally imported QFX / OFX or normalized CSV files. Pending transactions, outgoing payments and duplicate transaction IDs are not counted as receipts.</div><div class="panel"><h2>Chase business · QFX / OFX activity</h2><p class="small muted">Choose the account activity download in Chase and use QFX (Quicken) or OFX if offered. These files carry stable bank transaction IDs for duplicate checks. Account availability and download options depend on your Chase product.</p><form id="ofx-form"><div class="grid"><div class="field"><label for="ofx-account">Stable account nickname</label><input id="ofx-account" name="account" required maxlength="80" value="${state.settings.bankAccount || "CalBlue Chase business"}"></div><div class="field"><label for="ofx-file">QFX / OFX file</label><input id="ofx-file" type="file" accept=".qfx,.ofx" required></div></div><div class="actions"><button type="submit" class="primary">Import Chase activity</button></div></form></div><div class="panel"><h2>Import a normalized ${hasVenmo ? "Chase / Venmo" : "Chase"} CSV</h2><p class="small muted">Required: a stable transaction ID, date (YYYY-MM-DD), signed amount (incoming positive), currency (USD), status (posted/pending), and description. Use the same account nickname each time.${hasVenmo ? " For Venmo, normalize the statement to include gross payment amount, fee (positive; 0 if none), and kind (payment, payout, refund, other). Keep the original transaction ID. Completed incoming payments map to posted; do not label failed or refunded payments as posted. This importer does not read raw Venmo statement layouts." : ""}</p><label for="statement-source">Statement source</label><select id="statement-source"><option value="bank">Chase / bank (Zelle receipts)</option>${hasVenmo ? html`<option value="venmo">Venmo</option>` : null}</select><label for="bank-file">CSV file</label><input id="bank-file" type="file" accept=".csv,text/csv"><div class="actions"><button id="map-bank">Choose columns</button><button id="sample-bank">Download CSV format</button></div><div id="bank-mapping"></div></div><div class="panel"><h2>Unmatched incoming payments (${available.length})</h2>${!available.length ? html`<p class="empty">No posted incoming payments awaiting a match.</p>` : html`<div class="table-wrap"><table><thead><tr><th>Statement entry</th><th>Amount</th><th>Match</th></tr></thead><tbody>${available.map((t, index) => html`<tr><td>${t.date}<br>${t.description}<span class="small muted">${t.source === "venmo" ? "Venmo" : "Bank"} · ${t.account} · ${t.sourceId}</span></td><td>${money(t.amount)}${t.source === "venmo" ? html`<span class="small muted">Fee ${money(t.fee)} · Net ${money(t.amount - t.fee)}</span>` : null}</td><td><button data-match="${index}">Review candidates (${candidateInvoices(state, t).length})</button></td></tr>`)}</tbody></table></div>`}</div><div class="notice-box">${state.transactions.filter((t) => t.amount > 0 && t.status === "posted" && !isReceipt(t)).length} incoming rows excluded from dues matching. Venmo payouts in Chase and Venmo transfers/refunds are not player receipts. Review refunds against the original charge and reverse its payment when needed.</div><p class="small muted">${state.transactions.length} imported statement rows · Source file contents are not uploaded. Bank export evidence is self-supplied, not an authenticated bank verification.</p>`);
  submit("#ofx-form", async (form) => {
    const rows = parseOFX(await readFile($("#ofx-file").files[0], 5 * 1024 * 1024));
    const mapping = Object.fromEntries(["id", "date", "amount", "currency", "status", "description"].map((key) => [key, key]));
    const result = await commit((next) => { const result = importTransactions(next, rows, mapping, form.get("account")); next.settings.bankAccount = form.get("account").trim(); return result; });
    render(); notify(`${result.added} Chase activity rows imported; ${result.duplicates} duplicates skipped. Review incoming payments below.`);
  });
  action("#sample-bank", () => download("bank-import-format.csv", csv([["transaction_id", "date", "amount", "currency", "status", "description", "kind", "fee"]]), "text/csv"));
  action("#map-bank", async () => {
    const parsed = parseCSV(await readFile($("#bank-file").files[0], 5 * 1024 * 1024));
    const source = $("#statement-source").value;
    const fields = ["id", "date", "amount", "currency", "status", "description", ...(source === "venmo" ? ["kind", "fee"] : [])];
    mount($("#bank-mapping"), html`<form id="bank-form"><fieldset><legend>${parsed.rows.length} transaction rows</legend><div class="grid"><div class="field full"><label for="account">Account nickname (no account number)</label><input id="account" name="account" placeholder="CalBlue Chase business" required maxlength="80"></div>${fields.map((field) => html`<div class="field"><label for="map-${field}">${field === "amount" ? "Amount · incoming must be positive" : field}</label><select id="map-${field}" name="${field}">${parsed.headers.map((header) => html`<option>${header}</option>`)}</select></div>`)}</div></fieldset><div class="actions"><button type="submit" class="primary">Import statement rows</button></div></form>`);
    $("#account").value = state.settings[source === "venmo" ? "venmoAccount" : "bankAccount"] || (source === "venmo" ? "CalBlue Venmo" : "CalBlue Chase business");
    for (const field of fields) { const guess = parsed.headers.find((h) => h.toLowerCase() === field || (field === "id" && h.toLowerCase() === "transaction_id")); if (guess) $("#map-" + field).value = guess; }
    submit("#bank-form", async (form) => {
      const mapping = Object.fromEntries(fields.map((field) => [field, form.get(field)]));
      if (new Set(Object.values(mapping)).size !== fields.length) throw new Error("Choose a different column for each field.");
      const result = await commit((next) => { const result = importTransactions(next, parsed.rows, mapping, form.get("account"), source); next.settings[source === "venmo" ? "venmoAccount" : "bankAccount"] = form.get("account").trim(); return result; });
      render(); notify(`${result.added} statement rows imported; ${result.duplicates} exact duplicates skipped.`);
    });
  });
  document.querySelectorAll("[data-match]").forEach((button) => button.onclick = () => matchTransaction(available[Number(button.dataset.match)].id));
}
function matchTransaction(id) {
  const transaction = state.transactions.find((t) => t.id === id);
  const candidates = candidateInvoices(state, transaction).sort((a, b) => Number(b.referenceMatch) - Number(a.referenceMatch));
  mount(main, html`<p class="eyebrow">Confirm payment evidence</p><h1>${money(transaction.amount)} received</h1><div class="panel"><p>${transaction.date} · ${transaction.account}</p><p>${transaction.description}</p><p class="small muted">${transaction.source === "venmo" ? "Venmo" : "Bank"} reference: ${transaction.sourceId}</p><form id="match-form"><div class="field"><label for="match-invoice">Which charge does this pay?</label><select id="match-invoice" name="invoiceId" required><option value="">Select after checking the payer and reference</option>${candidates.map((i) => html`<option value="${i.id}">${playerName(i.playerId)} · ${i.title} · ${i.referenceMatch ? "Reference + amount match" : "Amount only"}</option>`)}</select></div><p class="small muted">Charges with enough remaining balance are listed, including partial payments. Check the payer and memo; an amount match is not proof. Combined payments need separate investigation.</p><div class="field"><label for="match-report">Link a player payment report (optional)</label><select id="match-report" name="reportId"><option value="">No report linked</option>${(state.paymentReports || []).filter((r) => !r.dismissed && r.amount === transaction.amount && (r.channel === "venmo") === (transaction.source === "venmo") && !state.payments.some((p) => !p.voided && p.reportId === r.id)).map((r) => html`<option value="${r.id}">${r.clubId} · ${r.channel} · ${r.date} · ${r.payer} · ${r.reference}</option>`)}</select></div><div class="field"><label for="match-note">How did you confirm the payer?</label><input id="match-note" name="note" required maxlength="500" placeholder="Reference and payer confirmed on bank statement"></div><label class="check"><input id="match-confirm" type="checkbox" required>I checked the payer, memo, date and receipt. This is a completed player payment for this charge, not a Venmo payout, transfer or refund.</label><div class="actions"><button type="submit" class="primary">Confirm receipt match</button><button type="button" id="cancel-match">Cancel</button></div></form></div>`);
  action("#cancel-match", render);
  submit("#match-form", async (form) => { await commit((next) => recordPayment(next, { invoiceId: form.get("invoiceId"), amount: transaction.amount, transactionId: id, reportId: form.get("reportId"), note: form.get("note") })); render(); notify("Payment matched and balance updated. Source: reviewed statement export."); });
}

function showExports() {
  mount(main, html`<p class="eyebrow">Reuse the details you already have</p><h1>Forms & exports</h1><p class="intro muted">Build a roster for a league or tournament without asking everyone again. Export selected columns, or map a form’s headings to player fields.</p><div class="panel"><h2>Roster CSV</h2><form id="export-form"><div class="export-fields">${Object.entries(FIELDS).map(([field, label]) => html`<label class="check"><input type="checkbox" name="fields" value="${field}">${label}</label>`)}</div><label class="check"><input type="checkbox" name="archived">Include archived players</label><label class="check"><input type="checkbox" required>I understand this export is unencrypted and will contain the selected personal information.</label><div class="actions"><button type="submit" class="primary">Download roster CSV</button></div></form></div><div class="panel"><h2>Match a form’s column headings</h2><p class="small muted">One line per column: <code>Form heading=playerField</code>. Use the field names below. This creates a reusable CSV for spreadsheet forms; it does not auto-fill an arbitrary PDF.</p><details><summary>Available player fields</summary><p class="code">${Object.keys(FIELDS).join(", ")}</p></details><form id="mapped-form"><label for="mapping">Column mapping</label><textarea id="mapping" name="mapping" rows="6"></textarea><label class="check"><input type="checkbox" required>I understand the generated file contains unencrypted personal information.</label><div class="actions"><button type="submit">Generate mapped CSV</button><button type="button" id="save-template">Download mapping template</button></div><label for="load-template">Load saved mapping template</label><input type="file" id="load-template" accept=".txt,text/plain"></form></div><div class="panel"><h2>Accounts & reminder batch</h2><p class="small muted">Export dues for bookkeeping, or prepare one reminder per outstanding charge. Reminder CSV is compatible with the optional local SMTP sender described in the guide. No email is sent by exporting.</p><label class="check"><input type="checkbox" id="finance-consent">I understand these exports contain unencrypted names, emails and amounts.</label><div class="actions"><button id="export-finance">Export charges CSV</button><button id="export-reminders">Export reminder batch CSV</button></div></div>`);
  for (const field of ["clubId", "firstName", "lastName", "leagueId", "jersey"]) $(`input[value="${field}"]`).checked = true;
  $("#mapping").value = "First Name=firstName\nLast Name=lastName\nBirth Date=dob\nPlayer ID=clubId\nJersey=jersey";
  submit("#export-form", async (form) => {
    const fields = form.getAll("fields"); if (!fields.length) throw new Error("Select at least one field.");
    const players = state.players.filter((p) => form.has("archived") || p.active);
    download(`calblue-roster-${today()}.csv`, csv([fields.map((f) => FIELDS[f]), ...players.map((p) => fields.map((f) => p[f]))]), "text/csv");
    notify("Roster CSV downloaded. It is unencrypted.");
  });
  submit("#mapped-form", async (form) => {
    const mapping = String(form.get("mapping")).split(/\r?\n/).filter((line) => line.trim()).map((line) => { const index = line.indexOf("="); return [line.slice(0, index).trim(), line.slice(index + 1).trim()]; });
    if (!mapping.length || mapping.some(([header, field]) => !header || !Object.hasOwn(FIELDS, field)) || new Set(mapping.map(([h]) => h)).size !== mapping.length) throw new Error("Use unique headings and valid player fields, one Heading=field pair per line.");
    download(`calblue-form-${today()}.csv`, csv([mapping.map(([header]) => header), ...state.players.filter((p) => p.active).map((p) => mapping.map(([, field]) => p[field]))]), "text/csv");
  });
  action("#save-template", () => download("calblue-form-template.txt", $("#mapping").value, "text/plain"));
  $("#load-template").onchange = async () => { try { $("#mapping").value = await readFile($("#load-template").files[0], 64 * 1024); } catch (error) { notify(error.message, true); } };
  action("#export-finance", () => {
    if (!$("#finance-consent").checked) throw new Error("Confirm the export privacy notice first.");
    download(`calblue-dues-${today()}.csv`, csv([["reference", "player", "title", "due", "currency", "amount", "balance", "status"], ...state.invoices.map((i) => [i.reference, playerName(i.playerId), i.title, i.due, "USD", (i.amount / 100).toFixed(2), (balance(state, i) / 100).toFixed(2), i.voided ? "voided" : balance(state, i) === 0 ? "paid" : "open"])]), "text/csv");
  });
  action("#export-reminders", () => {
    if (!$("#finance-consent").checked) throw new Error("Confirm the export privacy notice first.");
    download(`calblue-reminders-${today()}.csv`, csv([["invoice_id", "to", "subject", "body"], ...openInvoices().map((i) => { const message = reminder(state, i.id); return [i.id, message.to, message.subject, message.body]; })]), "text/csv");
    notify("Reminder batch downloaded. No email has been sent.");
  });
}

function showSettings() {
  mount(main, html`<p class="eyebrow">Keep the club’s records safe</p><h1>Backup & settings</h1><div class="panel"><h2>Encrypted backup</h2><p>This browser is your working copy. Export a backup after every session and keep a second copy somewhere safe. The backup includes profiles, images, financial records and the registration decryption key.</p><p class="small muted">Use a private backup location. Do not commit player data to the public website repository, including encrypted copies. Git history retains old versions. Losing both the passphrase and a usable vault backup is not recoverable.</p><div class="actions"><button id="backup" class="primary">Download encrypted backup</button></div></div><div class="panel"><h2>Payment reminder details</h2><p class="small muted">Club Zelle tag: <strong>${DEFAULT_PAYMENT_SETTINGS.zelleRecipient}</strong> · Recipient: <strong>${DEFAULT_PAYMENT_SETTINGS.zelleName}</strong></p><button id="use-club-zelle" type="button">Use club Zelle details</button><form id="settings-form"><div class="grid"><div class="field"><label for="senderName">Team signature</label><input id="senderName" name="senderName" value="${state.settings.senderName}" maxlength="120" required></div><div class="field"><label for="zelleRecipient">Zelle email, phone or tag</label><input id="zelleRecipient" name="zelleRecipient" maxlength="160" value="${state.settings.zelleRecipient || ""}"></div><div class="field"><label for="zelleName">Zelle recipient display name</label><input id="zelleName" name="zelleName" maxlength="160" value="${state.settings.zelleName || ""}"></div><details class="full"><summary>Optional: add Venmo later</summary><div class="grid"><div class="field"><label for="venmoUsername">Venmo username</label><input id="venmoUsername" name="venmoUsername" maxlength="80" value="${state.settings.venmoUsername || ""}"></div><div class="field"><label for="venmoName">Venmo recipient display name</label><input id="venmoName" name="venmoName" maxlength="160" value="${state.settings.venmoName || ""}"></div><div class="field"><label for="venmoProfile">Venmo profile type</label><select id="venmoProfile" name="venmoProfile"><option value="">Not specified</option><option value="personal">Personal</option><option value="business">Business</option></select></div></div></details><div class="field full"><label for="paymentInstructions">Approved payment instructions</label><textarea id="paymentInstructions" name="paymentInstructions" maxlength="2000"></textarea><p class="small muted">For example, the club’s Zelle email and memo instructions. Do not enter online banking credentials.</p></div></div><div class="actions"><button type="submit">Save settings</button></div></form></div><div class="panel"><h2>Change vault passphrase</h2><p class="small muted">Existing backups keep their original passphrase. Download a fresh backup after changing this one.</p><form id="password-form"><div class="grid"><div class="field"><label for="new-password">New passphrase</label><input id="new-password" name="password" type="password" minlength="14" required autocomplete="new-password"></div><div class="field"><label for="repeat-password">Repeat passphrase</label><input id="repeat-password" name="repeat" type="password" minlength="14" required autocomplete="new-password"></div></div><div class="actions"><button type="submit">Change passphrase</button></div></form></div><div class="panel"><h2>Recent activity</h2><p class="small muted">Local administrative history. It is not an independently tamper-proof audit service.</p><div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Record</th></tr></thead><tbody>${state.audit.slice(-30).reverse().map((event) => html`<tr><td>${event.at.replace("T", " ").slice(0, 19)} UTC</td><td>${event.action}</td><td class="code">${event.recordId}</td></tr>`)}</tbody></table></div></div>`);
  action("#use-club-zelle", () => { $("#zelleRecipient").value = DEFAULT_PAYMENT_SETTINGS.zelleRecipient; $("#zelleName").value = DEFAULT_PAYMENT_SETTINGS.zelleName; notify("Club Zelle details filled. Save settings to apply."); });
  $("#venmoProfile").value = state.settings.venmoProfile || "";
  $("#paymentInstructions").value = state.settings.paymentInstructions;
  action("#backup", () => { download(`calblue-${today()}-${Date.now()}.cbvault`, JSON.stringify(stored.envelope)); notify("Encrypted backup downloaded. Store the passphrase separately."); });
  submit("#settings-form", async (form) => { await commit((next) => { Object.assign(next.settings, paymentSettings(Object.fromEntries(form))); next.settings.senderName = form.get("senderName").trim(); next.settings.paymentInstructions = form.get("paymentInstructions").trim(); audit(next, "settings-updated", next.id); }); notify("Reminder settings saved."); });
  submit("#password-form", async (form) => {
    if (form.get("password") !== form.get("repeat")) throw new Error("Passphrases do not match.");
    if (busy) throw new Error("Wait for the current save."); busy = true; const epoch = generation;
    try {
      const nextSalt = crypto.getRandomValues(new Uint8Array(16));
      const nextKey = await passwordKey(form.get("password"), nextSalt);
      const next = structuredClone(state); audit(next, "passphrase-changed", next.id);
      const envelope = await vaultEnvelope(next, nextKey, nextSalt);
      if (epoch !== generation) throw new Error("Vault locked. Unlock and retry.");
      const nextRevision = await writeVault(envelope, revision);
      if (epoch === generation) { revision = nextRevision; key = nextKey; salt = nextSalt; state = next; stored = { revision, envelope }; showSettings(); download(`calblue-new-passphrase-${today()}.cbvault`, JSON.stringify(envelope)); notify("Passphrase changed. Fresh backup downloaded."); }
    } finally { busy = false; }
  });
}

for (const event of ["pointerdown", "keydown", "input"]) document.addEventListener(event, () => { if (state && Date.now() - lastActivity > 10 * 60 * 1000) lock(); lastActivity = Date.now(); }, true);
setInterval(() => { if (state && Date.now() - lastActivity > 10 * 60 * 1000) lock(); }, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && state && Date.now() - lastActivity > 10 * 60 * 1000) lock(); });
window.addEventListener("pagehide", () => { generation++; state = key = salt = null; main.replaceChildren(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) lock(); });
if (!crypto.subtle) mount(main, html`<h1>Secure browser required</h1><p>Open the office over HTTPS or on localhost. Encryption is unavailable on this connection.</p>`);
else showLocked().catch((error) => notify(error.message, true));

async function showPaymentLink(invoiceId) {
  const epoch = generation;
  const request = paymentRequest(state, invoiceId);
  const keyId = (await fingerprint(state.keys.publicKey)).slice(0, 16);
  if (!state || epoch !== generation) return;
  const url = new URL("pay.html", location.href);
  url.hash = new URLSearchParams({ club: JSON.stringify(validatePublicKey(state.keys.publicKey)), request: JSON.stringify(request) });
  mount(main, html`<p class="eyebrow">Share with this player</p><h1>Payment instructions</h1><div class="panel"><p>${request.clubId} · ${request.title} · ${money(request.amount)}</p><p>This link shows the approved payment destination and memo. After transferring, the player downloads an encrypted .cbpay report and sends it to you. Import it on this charge; it stays unverified until matched to a receipt.</p><p class="small muted">Club key to share: <span class="code">${keyId}</span></p><label for="payment-url">Player payment link</label><textarea id="payment-url" readonly></textarea><div class="actions"><button id="copy-payment-url">Copy link</button><a class="button" id="preview-payment" target="_blank" rel="noopener noreferrer">Preview player page</a><button id="payment-back">Back to charge</button></div><p class="small muted">The link includes the player ID, charge and payment destinations. It does not include the player's name, email or DOB. Share it directly with that player. It is a snapshot, not a live balance.</p>${["localhost", "127.0.0.1"].includes(location.hostname) ? html`<div class="notice-box">Local preview: teammates cannot open this localhost link remotely. Publish the program files over HTTPS, restore your vault there and generate a new link. The database remains encrypted in your browser.</div>` : null}</div>`);
  $("#payment-url").value = url.href; $("#preview-payment").href = url.href;
  action("#copy-payment-url", async () => { await navigator.clipboard.writeText(url.href); notify("Payment link copied."); });
  action("#payment-back", () => showInvoice(invoiceId));
}
function renderPaymentReports(invoiceId) {
  const reports = (state.paymentReports || []).filter((r) => r.invoiceId === invoiceId);
  mount($("#payment-reports"), html`<div class="panel"><h2>Player payment reports</h2><p class="small muted">Reports help identify the transfer. They never reduce the balance by themselves. Check Chase for Zelle; check the original Venmo receipt for Venmo.</p>${reports.map((r) => html`<p><span class="tag ${paymentReportStatus(state, r) === "Receipt reviewed" ? "good" : "warn"}">${paymentReportStatus(state, r)}</span> ${money(r.amount)} · ${r.channel} · ${r.date}<br>${r.payer} · ${r.reference || "No confirmation ID"}${paymentReportStatus(state, r) === "Awaiting receipt review" ? html` <button data-dismiss-report="${r.id}">Dismiss report</button>` : null}</p>`)}<label for="payment-report-file">Encrypted .cbpay file from player</label><input id="payment-report-file" type="file" accept=".cbpay,application/json"><div class="actions"><button id="import-payment-report">Import payment report</button><button id="review-receipts">Review incoming receipts</button></div></div>`);
  action("#import-payment-report", async () => {
    const epoch = generation;
    const box = JSON.parse(await readFile($("#payment-report-file").files[0], 1024 * 1024));
    if (!state || epoch !== generation) throw new Error("Vault locked. Unlock and retry.");
    const report = await openPaymentReport(box, state.keys);
    if (!state || epoch !== generation) throw new Error("Vault locked. Unlock and retry.");
    if (report.invoiceId !== invoiceId) throw new Error("Open the report's matching charge before importing.");
    await commit((next) => addPaymentReport(next, report)); showInvoice(invoiceId); notify("Payment reported. Balance is unchanged until the receipt is checked.");
  });
  action("#review-receipts", () => { page = "bank"; render(); });
  document.querySelectorAll("[data-dismiss-report]").forEach((button) => action(`[data-dismiss-report="${button.dataset.dismissReport}"]`, async () => {
    if (!await askConfirm("Dismiss this report? It remains in the history and does not change the invoice balance.")) return;
    await commit((next) => { next.paymentReports.find((r) => r.id === button.dataset.dismissReport).dismissed = true; audit(next, "payment-report-dismissed", button.dataset.dismissReport); }); showInvoice(invoiceId);
  }));
}
