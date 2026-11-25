import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../../club-office/crypto.js";
import { emptyState } from "../../club-office/model.js";

const password = "synthetic-test-passphrase-only";
test("vault encrypts all plaintext; unlock/backup round trip; wrong password and tamper rejected", async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const key = await c.passwordKey(password, salt);
  const state = emptyState(await c.newKeys()); state.players.push({ email: "synthetic@example.com", dob: "1990-01-01" });
  const box = await c.vaultEnvelope(state, key, salt);
  assert.equal(JSON.stringify(box).includes("synthetic@example.com"), false); assert.equal(JSON.stringify(box).includes(state.keys.privateKey.d), false);
  const recovered = await c.unlockEnvelope(box, password); assert.deepEqual(recovered.state, state);
  await assert.rejects(c.unlockEnvelope(box, "wrong-synthetic-passphrase"));
  const tampered = structuredClone(box); const bytes = c.unbase64(tampered.ciphertext); bytes[0] ^= 1; tampered.ciphertext = c.base64(bytes);
  await assert.rejects(c.unlockEnvelope(tampered, password));
  await assert.rejects(c.unlockEnvelope({ ...box, iterations: 1 }, password));
  const second = await c.vaultEnvelope(state, key, salt); assert.notEqual(second.iv, box.iv); assert.notEqual(second.ciphertext, box.ciphertext);
});
test("registration uses public key only; only matching private vault decrypts", async () => {
  const keys = await c.newKeys(); const player = { firstName: "Synthetic", photo: "x".repeat(100000) };
  const box = await c.sealRegistration(player, keys.publicKey);
  assert.equal(JSON.stringify(box).includes("Synthetic"), false); assert.deepEqual(await c.openRegistration(box, keys), player);
  await assert.rejects(c.openRegistration(box, await c.newKeys()));
  await assert.rejects(c.openRegistration({ ...box, format: "calblue-vault" }, keys));
  assert.throws(() => c.validatePublicKey(keys.privateKey));
});
test("passphrase and untrusted envelope resource limits", async () => {
  await assert.rejects(c.passwordKey("short", new Uint8Array(16)));
  assert.throws(() => c.unbase64("A".repeat(100), 12));
  assert.throws(() => c.unbase64("not base64!"));
});

test("encrypted payment reports round trip; registration packet cannot be substituted", async () => {
  const c = await import("../../club-office/crypto.js");
  const keys = await c.newKeys(); const payload = { payer: "Synthetic payer", amount: 10000 };
  const box = await c.sealPaymentReport(payload, keys.publicKey);
  assert.equal(JSON.stringify(box).includes(payload.payer), false);
  assert.deepEqual(await c.openPaymentReport(box, keys), payload);
  await assert.rejects(() => c.openRegistration(box, keys));
  box.format = "calblue-registration";
  await assert.rejects(() => c.openRegistration(box, keys));
});
