// Club-approved receiving details; no banking credentials.
export const DEFAULT_PAYMENT_SETTINGS = Object.freeze({ zelleRecipient: "gocalblue1996", zelleName: "CALBLUE CHINESE COMMUNITY" });
export const FIELDS = {
  firstName: "First name", lastName: "Last name", preferredName: "Preferred / Chinese name",
  email: "Email", phone: "Phone", dob: "Date of birth", address: "Address",
  emergencyName: "Emergency contact", emergencyPhone: "Emergency phone",
  guardian: "Parent / guardian contact (if applicable)", leagueId: "League player ID",
  clubId: "CalBlue player ID", joinYear: "Year joined CalBlue", jersey: "Jersey number",
};
export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validatePlayer(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid player record.");
  const player = {};
  for (const key of Object.keys(FIELDS)) {
    if (input[key] != null && typeof input[key] !== "string") throw new Error(`Invalid ${FIELDS[key]}.`);
    player[key] = (input[key] || "").trim();
    if (player[key].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(player[key])) throw new Error(`${FIELDS[key]} is too long or contains invalid characters.`);
  }
  if (!player.firstName || !player.lastName) throw new Error("First and last name are required.");
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(player.email)) throw new Error("Enter a valid email address.");
  if (!validDate(player.dob) || player.dob > today() || player.dob < "1900-01-01") throw new Error("Enter a valid date of birth.");
  if (player.jersey && !/^\d{1,3}$/.test(player.jersey)) throw new Error("Jersey number must be 0–999.");
  if (input.consent !== true) throw new Error("Player consent to store and use these details is required.");
  for (const key of ["photo"]) {
    const photo = input[key] || "";
    if (typeof photo !== "string" || photo.length > 3 * 1024 * 1024 || (photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(photo))) throw new Error("Invalid photo. Use a JPG, PNG or WebP image under 2 MB after resizing.");
    player[key] = photo;
  }
  player.joinYear = player.joinYear || today().slice(0, 4);
  if (!/^\d{4}$/.test(player.joinYear) || Number(player.joinYear) < 1900 || Number(player.joinYear) > Number(today().slice(0, 4))) throw new Error("Enter a valid year joined CalBlue.");
  player.consent = true;
  player.consentAt = typeof input.consentAt === "string" ? input.consentAt.slice(0, 40) : new Date().toISOString();
  return player;
}
export const fullName = (player) => `${player.firstName} ${player.lastName}`;
export function emptyState(keys) {
  return { version: 1, id: crypto.randomUUID(), keys, players: [], invoices: [], payments: [], paymentReports: [], transactions: [], audit: [], sequences: {}, settings: { ...DEFAULT_PAYMENT_SETTINGS, paymentInstructions: "", senderName: "CalBlue FC" } };
}
export function validateState(state) {
  if (state?.version !== 1 || !state.keys?.privateKey || !state.keys?.publicKey || !state.id || !state.settings) throw new Error("Invalid vault contents.");
  for (const key of ["players", "invoices", "payments", "transactions", "audit"]) if (!Array.isArray(state[key])) throw new Error("Invalid vault contents.");
  if (state.paymentReports !== undefined && !Array.isArray(state.paymentReports)) throw new Error("Invalid payment reports.");
  for (const player of state.players) validatePlayer(player);
  return state;
}
export function audit(state, action, recordId) {
  state.audit.push({ id: crypto.randomUUID(), at: new Date().toISOString(), action, recordId });
}
export function addPlayer(state, input) {
  const player = validatePlayer(input);
  if (state.players.some((p) => (p.email.toLowerCase() === player.email.toLowerCase() && p.dob === player.dob) || (fullName(p).toLowerCase() === fullName(player).toLowerCase() && p.dob === player.dob))) throw new Error("Possible duplicate player. Review and edit the existing record; imports never overwrite it.");
  const year = player.joinYear;
  state.sequences ||= {};
  const sequence = (state.sequences[year] || 0) + 1; state.sequences[year] = sequence;
  const clubId = `CB-${year}-${String(sequence).padStart(3, "0")}`;
  const record = { ...player, clubId, id: crypto.randomUUID(), active: true, reviewed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.players.push(record); audit(state, "player-created", record.id); return record;
}
export function updatePlayer(state, id, input) {
  const record = state.players.find((p) => p.id === id);
  if (!record) throw new Error("Player no longer exists.");
  const next = validatePlayer(input);
  if (state.players.some((p) => p.id !== id && ((p.email.toLowerCase() === next.email.toLowerCase() && p.dob === next.dob) || (fullName(p).toLowerCase() === fullName(next).toLowerCase() && p.dob === next.dob)))) throw new Error("Possible duplicate player.");
  Object.assign(record, next, { clubId: record.clubId, joinYear: record.joinYear, reviewed: false, updatedAt: new Date().toISOString() }); audit(state, "player-updated", id);
}
export function cents(value) {
  const text = String(value).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new Error("Enter a positive USD amount with at most two decimal places.");
  const amount = Math.round(Number(text) * 100);
  if (amount <= 0 || !Number.isSafeInteger(amount)) throw new Error("Amount must be positive.");
  return amount;
}
export const money = (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount / 100);
export function balance(state, invoice) { return invoice.voided ? 0 : invoice.amount - state.payments.filter((p) => p.invoiceId === invoice.id && !p.voided).reduce((sum, p) => sum + p.amount, 0); }
export function createInvoice(state, { playerId, title, amount, due }) {
  if (!state.players.some((p) => p.id === playerId && p.active)) throw new Error("Choose an active player.");
  if (typeof title !== "string" || !title.trim() || title.length > 160 || /[\r\n]/.test(title)) throw new Error("Enter a short invoice title.");
  if (!validDate(due)) throw new Error("Choose a valid due date.");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid invoice amount.");
  const id = crypto.randomUUID();
  const year = today().slice(0, 4);
  const sequenceKey = `invoice-${year}`;
  state.sequences[sequenceKey] = (state.sequences[sequenceKey] || 0) + 1;
  const invoice = { id, reference: `INV-${year}-${String(state.sequences[sequenceKey]).padStart(4, "0")}`, playerId, title: title.trim(), amount, due, currency: "USD", createdAt: new Date().toISOString(), voided: false };
  state.invoices.push(invoice); audit(state, "invoice-created", id); return invoice;
}
export function recordPayment(state, { invoiceId, amount, transactionId = "", reportId = "", note = "" }) {
  const invoice = state.invoices.find((i) => i.id === invoiceId);
  if (!invoice || invoice.voided || !Number.isSafeInteger(amount) || amount <= 0 || amount > balance(state, invoice)) throw new Error("Payment must be positive and no greater than the outstanding balance.");
  if (!note.trim() || note.length > 500) throw new Error("Add a payment reference or review note.");
  if (transactionId) {
    const transaction = state.transactions.find((t) => t.id === transactionId);
    if (!transaction || !isReceipt(transaction) || transaction.amount !== amount || transaction.currency !== "USD" || state.payments.some((p) => !p.voided && p.transactionId === transactionId)) throw new Error("This bank transaction is not available for matching.");
  }
  if (reportId) {
    const report = (state.paymentReports || []).find((r) => r.id === reportId);
    const transaction = state.transactions.find((t) => t.id === transactionId);
    if (!report || report.dismissed || report.invoiceId !== invoiceId || report.amount !== amount || !transaction || (report.channel === "venmo") !== (transaction.source === "venmo") || state.payments.some((p) => !p.voided && p.reportId === reportId)) throw new Error("The payment report does not match this receipt and charge.");
  }
  const payment = { id: crypto.randomUUID(), invoiceId, amount, transactionId, reportId, note, method: transactionId ? (state.transactions.find((t) => t.id === transactionId).source === "venmo" ? "venmo-reviewed" : "bank-reviewed") : "manual", createdAt: new Date().toISOString(), voided: false };
  state.payments.push(payment); audit(state, "payment-recorded", payment.id); return payment;
}
export function voidPayment(state, id) {
  const payment = state.payments.find((p) => p.id === id);
  if (!payment || payment.voided) throw new Error("Payment is already reversed or missing.");
  payment.voided = true; audit(state, "payment-reversed", id);
}
export function parseCSV(text) {
  if (typeof text !== "string" || text.length > 5 * 1024 * 1024) throw new Error("CSV is too large (5 MB maximum).");
  const rows = []; let row = [], cell = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; } else cell += c;
    } else if (c === '"' && cell === "" && !closed) quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; closed = false; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some((v) => v !== "")) rows.push(row); row = []; cell = ""; closed = false; }
    else { if (closed || c === '"') throw new Error("Malformed CSV quoting."); cell += c; }
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  row.push(cell); if (row.some((v) => v !== "")) rows.push(row);
  if (!rows.length || rows[0].some((h) => !h.trim()) || new Set(rows[0]).size !== rows[0].length || rows.some((r) => r.length !== rows[0].length)) throw new Error("CSV needs unique headers and the same number of columns on each row.");
  return { headers: rows[0], rows: rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) };
}
export function csv(rows) {
  return "\uFEFF" + rows.map((row) => row.map((value) => {
    let text = String(value ?? "");
    if (/^[\s]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n");
}
export function importTransactions(state, rows, mapping, account, source = "bank") {
  if (!["bank", "venmo"].includes(source)) throw new Error("Choose bank or Venmo as the statement source.");
  if (!account?.trim() || account.length > 80) throw new Error("Enter a stable account nickname (no account number).");
  account = account.trim().toLowerCase().replace(/\s+/g, " ");
  let added = 0, duplicates = 0;
  // Validate the complete batch before callers commit it.
  const pending = rows.map((row, index) => {
    const get = (key) => String(row[mapping[key]] || "").trim();
    const sourceId = get("id"), date = get("date"), currency = get("currency").toUpperCase(), status = get("status").toLowerCase();
    if (!sourceId || sourceId.length > 160 || !validDate(date) || currency !== "USD" || !["posted", "pending"].includes(status)) throw new Error(`Row ${index + 2}: require transaction ID, YYYY-MM-DD date, USD currency and posted/pending status.`);
    const amountText = get("amount");
    if (!/^-?\d{1,7}(\.\d{1,2})?$/.test(amountText)) throw new Error(`Row ${index + 2}: use signed decimal amounts; incoming credits must be positive.`);
    const kind = source === "venmo" ? get("kind").toLowerCase() : "bank-credit";
    if (source === "venmo" && !["payment", "payout", "refund", "other"].includes(kind)) throw new Error(`Row ${index + 2}: Venmo kind must be payment, payout, refund or other.`);
    const feeText = source === "venmo" ? get("fee") : "";
    if (source === "venmo" && !/^\d{1,7}(\.\d{1,2})?$/.test(feeText)) throw new Error(`Row ${index + 2}: Venmo fee is a nonnegative USD decimal (0 if none).`);
    const fee = feeText ? Math.round(Number(feeText) * 100) : 0;
    if (fee > Math.abs(Math.round(Number(amountText) * 100))) throw new Error(`Row ${index + 2}: fee exceeds gross amount.`);
    return { ...(source === "venmo" ? { source, kind, fee } : {}), id: JSON.stringify(source === "venmo" ? [source, account, sourceId] : [account, sourceId]), sourceId, account: account.trim(), date, amount: Math.round(Number(amountText) * 100), currency, status, description: get("description").slice(0, 1000) };
  });
  for (const transaction of pending) {
    const previous = state.transactions.find((t) => t.id === transaction.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(transaction)) throw new Error(`Transaction ${transaction.sourceId} has changed. Review it with the bank; it was not silently replaced.`);
      duplicates++; continue;
    }
    state.transactions.push(transaction); added++;
  }
  audit(state, "bank-import", `${added} added; ${duplicates} duplicates`);
  return { added, duplicates };
}
export function candidateInvoices(state, transaction) {
  if (!isReceipt(transaction) || state.payments.some((p) => !p.voided && p.transactionId === transaction.id)) return [];
  return state.invoices.filter((i) => !i.voided && balance(state, i) >= transaction.amount).map((i) => ({ ...i, referenceMatch: Boolean(i.reference) && transaction.description.toUpperCase().split(/[^A-Z0-9-]+/).includes(i.reference.toUpperCase()) }));
}
// OFX/QFX supplies FITID, a bank transaction ID absent from many Chase CSV exports.
// Parse the small transaction subset shared by XML OFX and legacy SGML OFX.
export function parseOFX(text) {
  if (typeof text !== "string" || text.length > 5 * 1024 * 1024 || !/<OFX[>\s]/i.test(text)) throw new Error("Choose an OFX or QFX bank activity export under 5 MB.");
  if ((text.match(/<STMTRS>/gi) || []).length !== 1) throw new Error("Import one bank account statement at a time.");
  const value = (block, tag) => (block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"))?.[1] || "").trim().replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"');
  const currency = value(text, "CURDEF").toUpperCase();
  if (currency !== "USD") throw new Error("Only USD bank statements are supported.");
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)];
  if (!blocks.length) throw new Error("No posted bank transactions found in this file.");
  return blocks.map(([, block]) => {
    const rawDate = value(block, "DTPOSTED");
    if (!/^\d{8}/.test(rawDate)) throw new Error("A bank transaction has an invalid posted date.");
    return { id: value(block, "FITID"), date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`, amount: value(block, "TRNAMT"), currency, status: "posted", description: [value(block, "NAME"), value(block, "MEMO")].filter(Boolean).join(" · ") };
  });
}
export function reminder(state, invoiceId) {
  const invoice = state.invoices.find((i) => i.id === invoiceId);
  if (!invoice || balance(state, invoice) <= 0) throw new Error("This invoice has no outstanding balance.");
  const player = state.players.find((p) => p.id === invoice.playerId);
  if ((state.paymentReports || []).some((r) => r.invoiceId === invoiceId && paymentReportStatus(state, r) === "Awaiting receipt review")) {
    return { to: player.email, subject: `CalBlue payment review: ${invoice.title}`, body: `Hi ${player.preferredName || player.firstName},\n\nThanks for reporting your payment for ${invoice.title}. We are still matching it to the incoming receipt. The ledger currently shows ${money(balance(state, invoice))} outstanding, but please do not send the payment again just because of this message.\n\nIf the transfer details changed, please reply with the method, date, payer name and confirmation ID. Reference: ${invoice.reference}.\n\nThanks,\n${state.settings.senderName || "CalBlue FC"}` };
  }
  return { to: player.email, subject: `CalBlue payment reminder: ${invoice.title}`, body: `Hi ${player.preferredName || player.firstName},\n\nA quick reminder that ${money(balance(state, invoice))} is outstanding for ${invoice.title} (due ${invoice.due}).\n\n${paymentInstructions(state.settings)}\n\nPlease include memo ${invoice.reference} ${player.clubId} with your payment. If you have already paid, please reply with the payment date and reference so we can match it.\n\nThanks,\n${state.settings.senderName || "CalBlue FC"}` };
}

// Imported statements are review evidence, not authenticated bank API responses.
export function isReceipt(transaction) {
  return transaction.status === "posted" && transaction.amount > 0 && transaction.currency === "USD" &&
    (transaction.source === "venmo" ? transaction.kind === "payment" : !/\bvenmo\b/i.test(transaction.description));
}
export function paymentSettings(input) {
  const result = {};
  for (const key of ["zelleRecipient", "zelleName", "venmoUsername", "venmoName", "venmoProfile"]) {
    const value = String(input[key] || "").trim();
    if (value.length > 160 || /[\r\n\x00-\x1f]/.test(value)) throw new Error("Use a single line for payment destinations.");
    result[key] = value;
  }
  result.venmoUsername = result.venmoUsername.replace(/^@/, "");
  if (result.venmoUsername && !/^[A-Za-z0-9_-]{2,80}$/.test(result.venmoUsername)) throw new Error("Enter the Venmo username, not a URL.");
  if (result.zelleRecipient && !result.zelleName) throw new Error("Enter the recipient name players should see in Zelle.");
  if (result.venmoUsername && !result.venmoName) throw new Error("Enter the recipient name players should see in Venmo.");
  if (!["", "personal", "business"].includes(result.venmoProfile)) throw new Error("Choose a Venmo profile type.");
  return result;
}
export function paymentInstructions(settings) {
  return [settings.zelleRecipient ? `Zelle: ${settings.zelleRecipient} — recipient ${settings.zelleName}` : "",
    settings.venmoUsername ? `Venmo: @${settings.venmoUsername} — recipient ${settings.venmoName}` : "",
    settings.paymentInstructions || ""].filter(Boolean).join("\n") || "Please contact the team manager for payment instructions.";
}
export function paymentRequest(state, invoiceId) {
  const invoice = state.invoices.find((i) => i.id === invoiceId);
  if (!invoice || balance(state, invoice) <= 0) throw new Error("This charge has no outstanding balance.");
  const destinations = paymentSettings(state.settings);
  if (!destinations.zelleRecipient && !destinations.venmoUsername) throw new Error("Add the club's Zelle or Venmo recipient in Backup & settings first.");
  const player = state.players.find((p) => p.id === invoice.playerId);
  return { version: 1, invoiceId, reference: invoice.reference, clubId: player.clubId, title: invoice.title, amount: balance(state, invoice), due: invoice.due, issuedAt: new Date().toISOString(), ...destinations, instructions: state.settings.paymentInstructions || "" };
}
export function validatePaymentRequest(input) {
  if (!input || input.version !== 1 || !/^[a-f0-9-]{36}$/.test(input.invoiceId) || !/^CB-\d{4}-\d{3,}$/.test(input.clubId) || typeof input.reference !== "string" || input.reference.length > 80 || typeof input.title !== "string" || input.title.length > 160 || !validDate(input.due) || !Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 999999999 || typeof input.issuedAt !== "string" || !Number.isFinite(Date.parse(input.issuedAt)) || typeof input.instructions !== "string" || input.instructions.length > 2000) throw new Error("Invalid payment request. Ask your manager for a fresh link.");
  return { ...input, ...paymentSettings(input) };
}
export function validatePaymentReport(input) {
  if (!input || !/^[a-f0-9-]{36}$/.test(input.id) || !/^[a-f0-9-]{36}$/.test(input.invoiceId) || !/^CB-\d{4}-\d{3,}$/.test(input.clubId) || !["zelle", "venmo"].includes(input.channel) || !Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 999999999 || !validDate(input.date) || input.date > today()) throw new Error("Invalid payment report. Check the amount, channel and payment date.");
  const result = { id: input.id, invoiceId: input.invoiceId, clubId: input.clubId, channel: input.channel, amount: input.amount, date: input.date };
  for (const field of ["payer", "reference"]) {
    if (typeof input[field] !== "string" || input[field].length > 160 || /[\x00-\x1f]/.test(input[field])) throw new Error("Invalid payer name or payment reference.");
    result[field] = input[field].trim();
  }
  if (!result.payer) throw new Error("Enter the name shown on the sending account.");
  return result;
}
export function addPaymentReport(state, input) {
  const report = validatePaymentReport(input);
  const invoice = state.invoices.find((i) => i.id === report.invoiceId);
  if (!invoice || state.players.find((p) => p.id === invoice.playerId)?.clubId !== report.clubId) throw new Error("This report does not belong to this charge and player.");
  state.paymentReports ||= [];
  if (state.paymentReports.some((r) => r.id === report.id)) throw new Error("This payment report was already imported.");
  state.paymentReports.push({ ...report, importedAt: new Date().toISOString(), dismissed: false });
  audit(state, "payment-reported-unverified", report.id); return report;
}
export function paymentReportStatus(state, report) {
  if (state.payments.some((p) => !p.voided && p.reportId === report.id)) return "Receipt reviewed";
  return report.dismissed ? "Dismissed" : "Awaiting receipt review";
}
