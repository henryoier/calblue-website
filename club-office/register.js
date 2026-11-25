import { validatePublicKey, fingerprint, sealRegistration } from "./crypto.js";
import { validatePlayer } from "./model.js";
import { $, html, mount, playerForm, configurePlayerForm, playerFormData, download } from "./shared.js";
let key;
const main = $("#main");
$(".skip").addEventListener("click", (event) => { event.preventDefault(); main.focus(); });
async function start() {
  if (!crypto.subtle) throw new Error("Open this form over HTTPS or on localhost in a modern browser.");
  const encoded = new URLSearchParams(location.hash.slice(1)).get("club");
  if (!encoded || encoded.length > 2000) throw new Error("Ask your team manager for the full registration link. It contains the club’s public encryption key.");
  key = validatePublicKey(JSON.parse(encoded));
  const keyId = (await fingerprint(key)).slice(0, 16);
  mount(main, html`<p class="eyebrow">CalBlue FC / Player registration</p><h1>One profile.<br>Ready for the season.</h1><p class="intro">Fill in your details once. Download the encrypted file and send it to your team manager through your usual team channel. Only the club vault can open it.</p><p class="small muted">Club key: <span class="code">${keyId}</span> · Confirm this matches the key your manager shared.</p><div class="panel">${playerForm()}</div>`);
  configurePlayerForm();
  $("#player-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = $("button[type=submit]"); button.disabled = true;
    try {
      const player = validatePlayer(await playerFormData());
      const box = await sealRegistration(player, key);
      download(`calblue-registration-${crypto.randomUUID().slice(0, 8)}.cbreg`, JSON.stringify(box));
      mount(main, html`<p class="eyebrow">Next: send your file</p><h1>Your registration is encrypted.</h1><div class="panel"><p>The file has been downloaded. Send the <strong>.cbreg</strong> file to your team manager. It has not been uploaded or delivered automatically.</p><p>After the manager imports and reviews it, your profile will be ready for club administration.</p><button id="again">Fill another registration</button></div>`);
      $("#again").onclick = () => location.reload();
    } catch (error) { $("#form-error").textContent = error.message; button.disabled = false; }
  });
}
start().catch((error) => mount(main, html`<h1>Registration link needed</h1><div class="panel"><p>${error.message}</p><a href="../">Back to CalBlue FC</a></div>`));
