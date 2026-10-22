import test from "node:test";
import assert from "node:assert/strict";
import * as m from "../../club-office/model.js";

const player = (extra = {}) => ({ firstName: "Test", lastName: "Player", email: "player@example.com", dob: "1995-02-28", joinYear: "2020", consent: true, ...extra });
function setup() { const state = m.emptyState({}); const p = m.addPlayer(state, player()); const invoice = m.createInvoice(state, { playerId: p.id, title: "Team dues", amount: 10000, due: "2026-10-01" }); return { state, p, invoice }; }
const mapping = Object.fromEntries(["id", "date", "amount", "currency", "status", "description"].map((x) => [x, x]));
const row = (extra = {}) => ({ id: "bank-001", date: "2026-10-01", amount: "100.00", currency: "USD", status: "posted", description: "Team dues", ...extra });

test("member ID uses join year; sequential, stable after edits and never reused", () => {
  const { state, p } = setup(); assert.equal(p.clubId, "CB-2020-001");
  m.updatePlayer(state, p.id, player({ firstName: "Renamed", clubId: "forged", joinYear: "2021" }));
  assert.equal(p.clubId, "CB-2020-001"); assert.equal(p.joinYear, "2020");
  state.players = [];
  assert.equal(m.addPlayer(state, player()).clubId, "CB-2020-002");
});
test("import cannot assign an existing or fabricated member ID", () => { const state = m.emptyState({}); assert.equal(m.addPlayer(state, player({ clubId: "CB-2000-001" })).clubId, "CB-2020-001"); });
test("duplicate email/dob or name/dob is refused without overwriting", () => {
  const { state } = setup(); assert.throws(() => m.addPlayer(state, player({ email: "PLAYER@example.com" })), /duplicate/);
  assert.throws(() => m.addPlayer(state, player({ email: "different@example.com" })), /duplicate/); assert.equal(state.players.length, 1);
});
test("invalid dates, future DOB, missing consent, document images and header injection", () => {
  for (const extra of [{ dob: "2025-02-29" }, { dob: "2999-01-01" }, { consent: false }, { email: "a@example.com\r\nBcc: x@example.com" }, { photo: "data:image/svg+xml;base64,PHN2Zz4=" }, { joinYear: "9999" }]) assert.throws(() => m.validatePlayer(player(extra)));
  assert.equal(m.validDate("2024-02-29"), true);
  assert.equal(m.validatePlayer(player({ idNumber: "not-collected", idPhoto: "not-collected" })).idNumber, undefined);
});
test("money rejects fractions of a cent, negatives, infinity and scientific notation", () => { for (const value of ["-1", "0", "1e3", "NaN", "1.001", "Infinity"]) assert.throws(() => m.cents(value)); assert.equal(m.cents("0.29"), 29); });
test("partial payment, overpayment rejection, reversal restores balance", () => {
  const { state, invoice } = setup(); const pay = m.recordPayment(state, { invoiceId: invoice.id, amount: 2500, note: "Cash checked" });
  assert.equal(m.balance(state, invoice), 7500);
  assert.throws(() => m.recordPayment(state, { invoiceId: invoice.id, amount: 8000, note: "Too much" }));
  m.voidPayment(state, pay.id); assert.equal(m.balance(state, invoice), 10000); assert.throws(() => m.voidPayment(state, pay.id));
});
test("CSV preserves quoted multiline cells; export neutralizes spreadsheet formulas", () => {
  assert.deepEqual(m.parseCSV('a,b\r\n"one,two","a\n""b"""').rows, [{ a: "one,two", b: 'a\n"b"' }]);
  const parsed = m.parseCSV(m.csv([["name", "phone"], ["=HYPERLINK(1)", "+15555550123"]]));
  assert.equal(parsed.rows[0].name, "'=HYPERLINK(1)"); assert.equal(parsed.rows[0].phone, "'+15555550123");
  for (const bad of ['a,a\n1,2', 'a,b\n1', 'a\n"x', 'a\n"x"y']) assert.throws(() => m.parseCSV(bad));
});
test("bank duplicate import is idempotent and changes cannot silently overwrite", () => {
  const { state } = setup(); assert.deepEqual(m.importTransactions(state, [row()], mapping, "Chase business"), { added: 1, duplicates: 0 });
  assert.deepEqual(m.importTransactions(state, [row()], mapping, "Chase business"), { added: 0, duplicates: 1 });
  assert.throws(() => m.importTransactions(state, [row({ amount: "101.00" })], mapping, "Chase business"), /changed/); assert.equal(state.transactions[0].amount, 10000);
});
test("bank import rejects ambiguous status, currency and non-ISO dates", () => {
  for (const extra of [{ currency: "EUR" }, { status: "paid" }, { id: "" }, { date: "10/01/2026" }]) assert.throws(() => m.importTransactions(m.emptyState({}), [row(extra)], mapping, "Chase"));
});
test("pending/outgoing rows never produce matches", () => {
  const { state } = setup(); m.importTransactions(state, [row({ status: "pending" }), row({ id: "debit", amount: "-100.00" })], mapping, "Chase");
  for (const t of state.transactions) assert.deepEqual(m.candidateInvoices(state, t), []);
});
test("bank matching uses exact balance, marks evidence source and forbids double credit", () => {
  const { state, invoice } = setup(); m.importTransactions(state, [row({ description: invoice.reference })], mapping, "Chase");
  const t = state.transactions[0]; assert.equal(m.candidateInvoices(state, t)[0].referenceMatch, true);
  const payment = m.recordPayment(state, { invoiceId: invoice.id, amount: 10000, transactionId: t.id, note: "Payer checked" });
  assert.equal(payment.method, "bank-reviewed"); assert.equal(m.balance(state, invoice), 0);
  assert.deepEqual(m.candidateInvoices(state, t), []);
  const second = m.createInvoice(state, { playerId: invoice.playerId, title: "Other dues", amount: 10000, due: "2026-10-02" });
  assert.throws(() => m.recordPayment(state, { invoiceId: second.id, amount: 10000, transactionId: t.id, note: "Already used" }));
});
test("matching cannot credit a pending or mismatched transaction", () => {
  const { state, invoice } = setup(); m.importTransactions(state, [row({ status: "pending" })], mapping, "Chase");
  assert.throws(() => m.recordPayment(state, { invoiceId: invoice.id, amount: 10000, transactionId: state.transactions[0].id, note: "Unposted" }));
});
test("reminders use outstanding balance and stop when paid", () => {
  const { state, invoice } = setup(); m.recordPayment(state, { invoiceId: invoice.id, amount: 2500, note: "Part paid" });
  assert.match(m.reminder(state, invoice.id).body, /\$75.00/);
  m.recordPayment(state, { invoiceId: invoice.id, amount: 7500, note: "Rest paid" }); assert.throws(() => m.reminder(state, invoice.id));
});
test("QFX parses bank-issued FITID and posted dates for exact deduplication", () => {
  const qfx = 'OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD\n<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT\n<DTPOSTED>20261001120000[-4:EDT]\n<TRNAMT>100.00\n<FITID>SYNTHETIC-001\n<NAME>Zelle credit\n<MEMO>Team &amp; season dues\n</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  const rows = m.parseOFX(qfx); assert.equal(rows[0].id, "SYNTHETIC-001"); assert.equal(rows[0].date, "2026-10-01"); assert.match(rows[0].description, /Team & season/);
  const state = m.emptyState({}); m.importTransactions(state, rows, mapping, "Chase"); assert.equal(state.transactions[0].amount, 10000);
  assert.throws(() => m.parseOFX(qfx.replace("USD", "EUR"))); assert.throws(() => m.parseOFX(qfx.replace("<STMTRS>", "<STMTRS><STMTRS>")));
});

test("invoice references are short, unique, separate from club IDs", () => {
  const { state, invoice, p } = setup();
  const next = m.createInvoice(state, { playerId: p.id, title: "Second charge", amount: 5000, due: "2026-10-02" });
  assert.match(invoice.reference, /^INV-\d{4}-0001$/);
  assert.match(next.reference, /^INV-\d{4}-0002$/);
  assert.notEqual(invoice.reference, p.clubId);
});

test("payment instructions and share payload include destinations but exclude profile PII", () => {
  const { state, invoice, p } = setup();
  state.settings.zelleRecipient = ""; state.settings.zelleName = "";
  assert.throws(() => m.paymentRequest(state, invoice.id), /recipient/);
  Object.assign(state.settings, m.paymentSettings({ zelleRecipient: "team@example.com", zelleName: "Synthetic club", venmoUsername: "@synthetic-club", venmoName: "Synthetic club", venmoProfile: "business" }));
  const request = m.validatePaymentRequest(m.paymentRequest(state, invoice.id));
  assert.equal(request.venmoUsername, "synthetic-club");
  for (const secret of [p.email, p.dob, p.firstName, p.lastName]) assert.equal(JSON.stringify(request).includes(secret), false);
  const message = m.reminder(state, invoice.id).body;
  assert.match(message, /team@example.com/); assert.match(message, /@synthetic-club/); assert.ok(message.includes(`${invoice.reference} ${p.clubId}`));
  assert.throws(() => m.paymentSettings({ zelleRecipient: "team@example.com" }), /recipient name/);
  assert.throws(() => m.paymentSettings({ venmoUsername: "https://fake.example/a" }));
  assert.throws(() => m.paymentSettings({ zelleRecipient: "a\nBcc: b" }));
});
const reportFor = (invoice, p, extra = {}) => ({ id: crypto.randomUUID(), invoiceId: invoice.id, clubId: p.clubId, channel: "zelle", amount: 10000, payer: "Synthetic payer", date: "2026-10-01", reference: "confirmation001", ...extra });
test("player report stays unverified, cannot credit balance, and wrong player/duplicate rejected", () => {
  const { state, invoice, p } = setup(); const report = reportFor(invoice, p);
  m.addPaymentReport(state, report); assert.equal(m.balance(state, invoice), 10000);
  assert.equal(m.paymentReportStatus(state, report), "Awaiting receipt review");
  assert.throws(() => m.addPaymentReport(state, report), /already/);
  assert.throws(() => m.addPaymentReport(state, reportFor(invoice, p, { clubId: "CB-2020-999" })), /belong/);
  assert.throws(() => m.addPaymentReport(state, reportFor(invoice, p, { date: "2999-01-01" })));
  assert.throws(() => m.recordPayment(state, { invoiceId: invoice.id, amount: 10000, reportId: report.id, note: "No receipt" }), /report/);
});
test("reviewed receipt can resolve report; reversal reopens it and disallows double credit", () => {
  const { state, invoice, p } = setup(); const report = m.addPaymentReport(state, reportFor(invoice, p));
  m.importTransactions(state, [row()], mapping, "Chase");
  const payment = m.recordPayment(state, { invoiceId: invoice.id, amount: 10000, reportId: report.id, transactionId: state.transactions[0].id, note: "Checked original receipt" });
  assert.equal(m.paymentReportStatus(state, report), "Receipt reviewed");
  assert.equal(m.balance(state, invoice), 0);
  m.voidPayment(state, payment.id); assert.equal(m.paymentReportStatus(state, report), "Awaiting receipt review");
  assert.equal(m.balance(state, invoice), 10000);
});
test("Venmo gross payment settles dues, fees recorded separately; Chase payout cannot settle again", () => {
  const { state, invoice, p } = setup(); const report = m.addPaymentReport(state, reportFor(invoice, p, { channel: "venmo" }));
  const venmoMapping = { ...mapping, kind: "kind", fee: "fee" };
  const vrow = row({ id: "venmo001", kind: "payment", fee: "2.00", description: `${invoice.reference} ${p.clubId}` });
  m.importTransactions(state, [vrow], venmoMapping, "Club Venmo", "venmo");
  m.importTransactions(state, [row({ description: "VENMO CASHOUT" })], mapping, "Chase");
  assert.equal(m.isReceipt(state.transactions[1]), false);
  assert.deepEqual(m.candidateInvoices(state, state.transactions[1]), []);
  assert.throws(() => m.recordPayment(state, { invoiceId: invoice.id, amount: 10000, transactionId: state.transactions[1].id, note: "Payout not a receipt" }));
  const payment = m.recordPayment(state, { invoiceId: invoice.id, amount: 10000, transactionId: state.transactions[0].id, reportId: report.id, note: "Payer and memo confirmed" });
  assert.equal(payment.method, "venmo-reviewed"); assert.equal(state.transactions[0].fee, 200); assert.equal(m.balance(state, invoice), 0);
  assert.equal(m.importTransactions(state, [vrow], venmoMapping, " Club  Venmo ", "venmo").duplicates, 1);
});
test("Venmo transfers, refunds, pending and debits are excluded; missing type and fee rejected", () => {
  const { state } = setup(); const vm = { ...mapping, kind: "kind", fee: "fee" };
  for (const kind of ["payout", "refund", "other"]) m.importTransactions(state, [row({ id: kind, kind, fee: "0" })], vm, "Venmo", "venmo");
  m.importTransactions(state, [row({ id: "pending", kind: "payment", fee: "0", status: "pending" }), row({ id: "debit", kind: "payment", fee: "0", amount: "-100" })], vm, "Venmo", "venmo");
  assert.ok(state.transactions.every((t) => !m.isReceipt(t)));
  for (const extra of [{ kind: "" }, { fee: "" }, { fee: "-2" }, { fee: "101" }]) assert.throws(() => m.importTransactions(state, [row({ kind: "payment", fee: "0", ...extra })], vm, "Venmo", "venmo"));
});
test("partial receipt candidates preserve amount due and reference match uses complete token", () => {
  const { state, invoice } = setup();
  m.importTransactions(state, [row({ amount: "25", description: invoice.reference + "9" })], mapping, "Chase");
  const t = state.transactions[0], candidates = m.candidateInvoices(state, t);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].referenceMatch, false);
  m.recordPayment(state, { invoiceId: invoice.id, amount: 2500, transactionId: t.id, note: "Partial payment payer checked" });
  assert.equal(m.balance(state, invoice), 7500);
});
test("report cannot be linked to wrong channel or invoice even when amounts match", () => {
  const { state, invoice, p } = setup(); const report = m.addPaymentReport(state, reportFor(invoice, p, { channel: "venmo" }));
  m.importTransactions(state, [row()], mapping, "Chase");
  assert.throws(() => m.recordPayment(state, { invoiceId: invoice.id, amount: 10000, transactionId: state.transactions[0].id, reportId: report.id, note: "Wrong channel" }), /report/);
  assert.equal(m.balance(state, invoice), 10000);
});

test("reported payments get review follow-up instead of another payment request", () => {
  const { state, invoice, p } = setup(); m.addPaymentReport(state, reportFor(invoice, p));
  const message = m.reminder(state, invoice.id);
  assert.match(message.subject, /payment review/); assert.match(message.body, /do not send the payment again/);
  assert.equal(message.body.includes("Please include memo"), false); assert.equal(m.balance(state, invoice), 10000);
});

test("new club vault defaults to confirmed Zelle details without Venmo", () => {
  const { state, invoice } = setup();
  const request = m.paymentRequest(state, invoice.id);
  assert.equal(request.zelleRecipient, "gocalblue1996");
  assert.equal(request.zelleName, "CALBLUE CHINESE COMMUNITY");
  assert.equal(request.venmoUsername, "");
  assert.equal(m.paymentInstructions(state.settings).includes("Venmo"), false);
});
