// Browser-native authenticated encryption. No keys or plaintext go to storage.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const ITERATIONS = 600000;
export const MAX_PACKAGE = 16 * 1024 * 1024;
const aad = (kind) => encoder.encode(`CalBlue:${kind}:1`);
export function base64(bytes) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
export function unbase64(value, max = MAX_PACKAGE) {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid encrypted file.");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export async function passwordKey(password, salt) {
  if (typeof password !== "string" || password.length < 14) throw new Error("Use a passphrase of at least 14 characters.");
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptObject(value, key, kind) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(kind) }, key, data);
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
export async function decryptObject(box, key, kind, max = MAX_PACKAGE) {
  const iv = unbase64(box.iv, 12);
  if (iv.length !== 12) throw new Error("Invalid encrypted file.");
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(kind) }, key, unbase64(box.ciphertext, max));
  return JSON.parse(decoder.decode(data));
}
export async function newKeys() {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  return { publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}
export function validatePublicKey(jwk) {
  if (!jwk || jwk.kty !== "RSA" || jwk.e !== "AQAB" || typeof jwk.n !== "string" || jwk.n.length !== 512 || jwk.d) throw new Error("Invalid club registration key.");
  return { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true };
}
export async function fingerprint(jwk) {
  const key = validatePublicKey(jwk);
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${key.n}.${key.e}`))));
}
async function sealPacket(player, jwk, kind) {
  const publicKey = await crypto.subtle.importKey("jwk", validatePublicKey(jwk), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, await crypto.subtle.exportKey("raw", key));
  return { format: `calblue-${kind}`, version: 1, keyId: await fingerprint(jwk), wrappedKey: base64(new Uint8Array(wrapped)), ...await encryptObject(player, key, kind) };
}
async function openPacket(box, keys, kind) {
  if (box.format !== `calblue-${kind}` || box.version !== 1 || box.keyId !== await fingerprint(keys.publicKey)) throw new Error("This registration belongs to a different club vault or has an unsupported format.");
  const privateKey = await crypto.subtle.importKey("jwk", keys.privateKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, unbase64(box.wrappedKey, 384));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  return decryptObject(box, key, kind);
}
export async function vaultEnvelope(state, key, salt) {
  return { format: "calblue-vault", version: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: base64(salt), ...await encryptObject(state, key, "vault") };
}
export async function unlockEnvelope(box, password) {
  if (box?.format !== "calblue-vault" || box.version !== 1 || box.kdf !== "PBKDF2-SHA256" || box.iterations !== ITERATIONS) throw new Error("Unsupported vault format.");
  const salt = unbase64(box.salt, 16);
  if (salt.length !== 16) throw new Error("Invalid vault salt.");
  const key = await passwordKey(password, salt);
  try { return { state: await decryptObject(box, key, "vault", 256 * 1024 * 1024), key, salt }; }
  catch { throw new Error("Cannot unlock: check the passphrase and that the backup is intact."); }
}

export const sealRegistration = (player, jwk) => sealPacket(player, jwk, "registration");
export const openRegistration = (box, keys) => openPacket(box, keys, "registration");
export const sealPaymentReport = (report, jwk) => sealPacket(report, jwk, "payment-report");
export const openPaymentReport = (box, keys) => openPacket(box, keys, "payment-report");
