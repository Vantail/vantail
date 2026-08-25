/**
 * The signing side of the updater.
 *
 * Ed25519, using Node's own crypto - no dependency, and no key material ever
 * leaves this process except into the file you point it at.
 *
 * The private key signs release archives. The public half goes in
 * `vantail.config.ts` and ends up compiled into every copy of the application,
 * which is what makes an update forgeable only by whoever holds the private
 * one.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";

export interface GeneratedKeys {
  /** PKCS#8 PEM. Secret. */
  privateKeyPem: string;
  /** base64 of the raw 32-byte key, for `updater.publicKey`. */
  publicKey: string;
}

export function generateKeys(): GeneratedKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    // An SPKI DER for Ed25519 ends with the 32 raw key bytes, which is the
    // form the runtime's verifier wants.
    publicKey: Buffer.from(publicKey.export({ format: "der", type: "spki" }))
      .subarray(-32)
      .toString("base64"),
  };
}

/**
 * Load a signing key.
 *
 * From `$VANTAIL_UPDATER_KEY` if it is set - a PEM, so CI can hold it in a
 * secret - otherwise from a file.
 */
export async function loadPrivateKey(path?: string): Promise<KeyObject> {
  const inline = process.env["VANTAIL_UPDATER_KEY"];
  const pem = inline ?? (path ? await readFile(path, "utf8") : undefined);

  if (!pem) {
    throw new Error(
      "No signing key. Pass --key <path>, or set VANTAIL_UPDATER_KEY to the key itself.\n" +
        "Generate one with `vantail updater keygen`.",
    );
  }

  try {
    return createPrivateKey(pem);
  } catch (error) {
    throw new Error(
      `That is not a usable Ed25519 private key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Sign bytes, returning the base64 signature a manifest carries. */
export function signPayload(key: KeyObject, payload: Buffer): string {
  // Ed25519 hashes internally, so the algorithm argument is null.
  return signBytes(null, payload, key).toString("base64");
}

/** The public key that matches a private one, for checking a config. */
export function publicKeyOf(key: KeyObject): string {
  return Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" }))
    .subarray(-32)
    .toString("base64");
}
