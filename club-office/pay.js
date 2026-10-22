import { validatePublicKey, fingerprint, sealPaymentReport } from "./crypto.js";
import { validatePaymentRequest, validatePaymentReport, cents, money, today, paymentInstructions } from "./model.js";
import { $, html, mount, download } from "./shared.js";
const main = $("#main");
$(".skip").addEventListener("click", (event) => { event.preventDefault(); main.focus(); });
async function start() {
  if (!crypto.subtle) throw new Error("Use HTTPS or localhost in a modern browser.");
  if (location.hash.length > 40000) throw new Error("Invalid payment link.");
  const params = new URLSearchParams(location.hash.slice(1));
  const key = validatePublicKey(JSON.parse(params.get("club")));
  const request = validatePaymentRequest(JSON.parse(params.get("request")));
  const memo = `${request.reference} ${request.clubId}`;
  mount(main, html`<p class="eyebrow">CalBlue FC / Team payment</p><h1>${request.title}</h1><p class="intro"><strong>${money(request.amount)}</strong> requested · Due ${request.due}<br>Player ${request.clubId}</p><div class="panel"><h2>1. Transfer with ${request.zelleRecipient && request.venmoUsername ? "Zelle or Venmo" : request.zelleRecipient ? "Zelle" : "Venmo"}</h2><pre>${paymentInstructions({ ...request, paymentInstructions: request.instructions })}</pre><p>Check the recipient name in your payment app before sending. Confirm these details with your team manager if they have changed.</p><label for="memo">Payment memo</label><input id="memo" readonly value="${memo}"><button id="copy-memo">Copy memo</button><p class="small muted">Use only this reference in the payment memo. Do not include your birthday or other personal details.</p></div><div class="panel"><h2>2. Report your payment</h2><p>This tells your manager what to look for. Your charge is paid only after the incoming payment is reviewed.</p><form id="report-form"><div class="grid"><div class="field"><label for="channel">Payment method</label><select id="channel" name="channel" required><option value="">Choose method</option>${request.zelleRecipient ? html`<option value="zelle">Zelle</option>` : null}${request.venmoUsername ? html`<option value="venmo">Venmo</option>` : null}</select></div><div class="field"><label for="payer">Name / username on sending account</label><input id="payer" name="payer" maxlength="160" required autocomplete="name"></div><div class="field"><label for="amount">Amount you transferred (USD)</label><input id="amount" name="amount" inputmode="decimal" value="${(request.amount / 100).toFixed(2)}" required></div><div class="field"><label for="date">Transfer date</label><input id="date" name="date" type="date" max="${today()}" value="${today()}" required></div><div class="field full"><label for="reference">Transfer confirmation / transaction ID (if shown)</label><input id="reference" name="reference" maxlength="160"></div></div><label class="check"><input type="checkbox" required>I have made this transfer. I understand this report is not confirmation of receipt.</label><p class="error" id="form-error" role="alert"></p><div class="actions"><button class="primary" type="submit">Download encrypted payment report</button></div></form></div><p class="small muted">This request is a snapshot from ${request.issuedAt.slice(0, 10)}. If you already paid or the amount changed, check with your manager before transferring again. This page does not charge you or read bank activity.</p><p class="small muted">Club key: <span class="code">${(await fingerprint(key)).slice(0, 16)}</span> · Compare with the key shared by your manager.</p>`);
  if (!request.venmoUsername) $("#channel").value = "zelle";
  else if (!request.zelleRecipient) $("#channel").value = "venmo";
  $("#copy-memo").onclick = async () => { try { await navigator.clipboard.writeText(memo); $("#copy-memo").textContent = "Copied"; } catch { $("#memo").select(); } };
  $("#report-form").onsubmit = async (event) => {
    event.preventDefault(); const button = $("button[type=submit]"); button.disabled = true;
    try {
      const form = new FormData(event.target);
      const report = validatePaymentReport({ id: crypto.randomUUID(), invoiceId: request.invoiceId, clubId: request.clubId, channel: form.get("channel"), payer: form.get("payer"), date: form.get("date"), amount: cents(form.get("amount")), reference: form.get("reference") });
      const packet = await sealPaymentReport(report, key);
      download(`calblue-payment-${report.id.slice(0, 8)}.cbpay`, JSON.stringify(packet));
      mount(main, html`<p class="eyebrow">One more step</p><h1>Send your payment report.</h1><div class="panel"><p>Your encrypted <strong>.cbpay</strong> file has downloaded. Send it to your team manager through your usual team channel.</p><p>It has not been uploaded or delivered automatically. Your manager will match it to the ${report.channel === "zelle" ? "Chase" : "Venmo"} receipt before marking the charge paid.</p></div>`);
    } catch (error) { $("#form-error").textContent = error.message; button.disabled = false; }
  };
}
start().catch((error) => mount(main, html`<h1>Payment link needed</h1><div class="panel"><p>${error.message}</p><p>Ask your team manager for the complete link.</p></div>`));
