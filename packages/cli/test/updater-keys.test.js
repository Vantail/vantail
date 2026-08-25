import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";

import { generateKeys, loadPrivateKey, publicKeyOf, signPayload } from "../dist/updater-keys.js";

/** How the runtime holds a public key: 32 raw bytes, base64. */
function rawPublicKey(pem) {
  return Buffer.from(createPublicKey(pem).export({ format: "der", type: "spki" }))
    .subarray(-32)
    .toString("base64");
}

test("a generated key pair matches itself", () => {
  const keys = generateKeys();
  assert.match(keys.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  // 32 bytes, base64 - exactly what ed25519-dalek's VerifyingKey wants.
  assert.equal(Buffer.from(keys.publicKey, "base64").length, 32);
  assert.equal(rawPublicKey(keys.privateKeyPem), keys.publicKey);
});

test("a signature verifies against the published public key", async () => {
  const keys = generateKeys();
  const key = await loadPrivateKey.call(null, undefined).catch(() => undefined);
  assert.equal(key, undefined, "no key configured means no key loaded");

  process.env.VANTAIL_UPDATER_KEY = keys.privateKeyPem;
  try {
    const loaded = await loadPrivateKey();
    const payload = Buffer.from("pretend this is a tar.gz");
    const signature = signPayload(loaded, payload);

    // Ed25519 signatures are 64 bytes and hash internally, so the algorithm
    // argument is null on both sides.
    assert.equal(Buffer.from(signature, "base64").length, 64);
    assert.equal(
      verify(null, payload, createPublicKey(keys.privateKeyPem), Buffer.from(signature, "base64")),
      true,
    );
    assert.equal(publicKeyOf(loaded), keys.publicKey);
  } finally {
    delete process.env.VANTAIL_UPDATER_KEY;
  }
});

test("a signature does not verify against a different key", async () => {
  const mine = generateKeys();
  const theirs = generateKeys();

  process.env.VANTAIL_UPDATER_KEY = mine.privateKeyPem;
  try {
    const payload = Buffer.from("release archive");
    const signature = signPayload(await loadPrivateKey(), payload);
    assert.equal(
      verify(null, payload, createPublicKey(theirs.privateKeyPem), Buffer.from(signature, "base64")),
      false,
    );
  } finally {
    delete process.env.VANTAIL_UPDATER_KEY;
  }
});

test("a changed payload invalidates the signature", async () => {
  const keys = generateKeys();
  process.env.VANTAIL_UPDATER_KEY = keys.privateKeyPem;
  try {
    const payload = Buffer.from("release archive");
    const signature = Buffer.from(signPayload(await loadPrivateKey(), payload), "base64");

    const tampered = Buffer.from(payload);
    tampered[0] ^= 0xff;
    assert.equal(verify(null, tampered, createPublicKey(keys.privateKeyPem), signature), false);
  } finally {
    delete process.env.VANTAIL_UPDATER_KEY;
  }
});

test("a missing key says how to make one", async () => {
  await assert.rejects(loadPrivateKey(), /vantail updater keygen/);
});
