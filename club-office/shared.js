import { html, mount } from "../app/js/dom.js";
import { FIELDS, today } from "./model.js";
export { html, mount };
export const $ = (selector, root = document) => root.querySelector(selector);
export function askConfirm(message) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    mount(dialog, html`<h2>Please confirm</h2><p>${message}</p><div class="actions"><button data-cancel autofocus>Cancel</button><button data-confirm class="primary">Confirm</button></div>`);
    const finish = (answer) => { document.removeEventListener("vault-lock", cancel); dialog.close(); dialog.remove(); resolve(answer); };
    const cancel = () => finish(false);
    $("[data-cancel]", dialog).onclick = cancel;
    $("[data-confirm]", dialog).onclick = () => finish(true);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
    document.addEventListener("vault-lock", cancel, { once: true });
    document.body.append(dialog); dialog.showModal();
  });
}
let noticeTimer;
export function notify(message, error = false) {
  const notice = $("#notice"); notice.textContent = message; notice.classList.toggle("error", error);
  clearTimeout(noticeTimer);
  if (!error) noticeTimer = setTimeout(() => { notice.textContent = ""; }, 6000);
}
export function download(name, contents, type = "application/json") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function readFile(file, max = 16 * 1024 * 1024) {
  if (!file || file.size > max) throw new Error(`Choose a file under ${Math.round(max / 1024 / 1024)} MB.`);
  return file.text();
}
export async function photoData(file) {
  if (!file) return null;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error("Choose a JPG, PNG or WebP photo under 8 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40000000) throw new Error("Photo dimensions are too large.");
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Re-encoding strips EXIF and GPS metadata; no original document is persisted.
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally { bitmap.close(); }
}
export function playerForm(player = {}, admin = false) {
  const field = (key, required = false) => html`<div class="field"><label for="${key}">${FIELDS[key]}${required ? " *" : ""}</label><input id="${key}" name="${key}" type="${key === "email" ? "email" : key === "dob" ? "date" : ["phone", "emergencyPhone"].includes(key) ? "tel" : "text"}" value="${player[key] || ""}" maxlength="500" autocomplete="off"></div>`;
  return html`<form id="player-form">
    <fieldset><legend>Player details</legend><div class="grid">${["firstName", "lastName", "preferredName", "email", "phone", "dob", "joinYear", "leagueId", "jersey"].map((key) => field(key, ["firstName", "lastName", "email", "dob"].includes(key)))}</div></fieldset>
    <fieldset><legend>Contact & emergency</legend><div class="grid">${["address", "emergencyName", "emergencyPhone", "guardian"].map((key) => field(key))}</div></fieldset>
    <fieldset><legend>Player photo</legend><p class="small muted">A clear, front-facing headshot. JPG, PNG or WebP; up to 8 MB. Photos are resized and location metadata is removed.</p><label for="photo">Choose headshot${player.photo ? " (leave blank to keep current)" : ""}</label><input type="file" id="photo" accept="image/jpeg,image/png,image/webp">${player.photo ? html`<label class="check"><input type="checkbox" id="remove-photo">Remove current headshot</label>` : null}</fieldset>
    <div class="notice-box">Used for club administration, competition registration and payment reminders. Contact the team manager to correct or delete your record. This does not publish your profile or enroll you in a league.</div>
    <label class="check"><input type="checkbox" id="consent" name="consent">${admin ? "The player (or guardian) has agreed to the club storing these details and using them for registration and payment reminders." : "I agree to CalBlue storing these details and using them for registration and payment reminders. I am the player or their parent / guardian."}</label>
    <p id="form-error" class="error" role="alert"></p><div class="actions"><button class="primary" type="submit">${admin ? "Save player" : "Download encrypted registration"}</button></div>
  </form>`;
}
export function configurePlayerForm(player = {}) {
  for (const field of ["firstName", "lastName", "email", "dob"]) $("#" + field).required = true;
  $("#joinYear").value = player.joinYear || today().slice(0, 4);
  $("#joinYear").readOnly = Boolean(player.id);
  $("#dob").max = today(); $("#dob").min = "1900-01-01";
  $("#consent").required = true; $("#consent").checked = player.consent === true;
}
export async function playerFormData(player = {}) {
  const form = $("#player-form");
  const input = Object.fromEntries(new FormData(form)); input.consent = $("#consent").checked;
  input.consentAt = player.consentAt || new Date().toISOString();
  for (const key of ["photo"]) input[key] = $("#remove-" + key)?.checked ? "" : await photoData($("#" + key).files[0]) ?? player[key] ?? "";
  return input;
}
