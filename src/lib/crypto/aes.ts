// ---------------------------------------------------------------------------
// Low-level AES-256-GCM primitives shared by userVault and serverVault.
//
// Both vault scopes (a per-user password-derived key, and the server-wide
// env-var key) need identical encrypt/decrypt mechanics. Keeping that in one
// file means a bug fix or format change only has to happen once, and neither
// vault module can quietly diverge in how it picks a nonce or lays out
// ciphertext.
//
// Wire format: "v1:<base64 nonce>:<base64 ciphertext+authTag>"
// The leading version tag lets the scheme change later (e.g. a different
// AEAD) without ambiguity — old and new ciphertexts are told apart just by
// reading the prefix, no separate migration-tracking column needed.
//
// Never log plaintext, keys, or derived key material from this module or
// its callers.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12; // 96-bit nonce, the size GCM is designed around
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256
const FORMAT_VERSION = "v1";

/** Thrown for any decrypt failure — tampered ciphertext, wrong key, or a
 *  malformed envelope. Deliberately one error type: distinguishing "bad key"
 *  from "bad ciphertext" to a caller would leak information useful to an
 *  attacker for free (an oracle for which part of the input was wrong). */
export class DecryptionError extends Error {
  constructor(message = "Failed to decrypt payload") {
    super(message);
    this.name = "DecryptionError";
  }
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`AES-256 key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
}

/** Encrypts `plaintext` under `key`, generating a fresh random nonce on every
 *  call — reusing a nonce with the same GCM key breaks confidentiality. */
export function encrypt(key: Buffer, plaintext: string | Buffer): string {
  assertKeyLength(key);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const plaintextBuf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([ciphertext, authTag]);
  return `${FORMAT_VERSION}:${nonce.toString("base64")}:${payload.toString("base64")}`;
}

/** Decrypts a payload produced by `encrypt`, returning the raw plaintext
 *  bytes. Throws DecryptionError on any tamper, wrong-key, or format issue. */
export function decrypt(key: Buffer, payload: string): Buffer {
  assertKeyLength(key);

  const parts = payload.split(":");
  if (parts.length !== 3 || parts[0] !== FORMAT_VERSION) {
    throw new DecryptionError("Unrecognized ciphertext format");
  }
  const [, nonceB64, dataB64] = parts;

  let nonce: Buffer;
  let data: Buffer;
  try {
    nonce = Buffer.from(nonceB64, "base64");
    data = Buffer.from(dataB64, "base64");
  } catch {
    throw new DecryptionError("Malformed ciphertext encoding");
  }

  if (nonce.length !== NONCE_LENGTH || data.length < AUTH_TAG_LENGTH) {
    throw new DecryptionError("Malformed ciphertext");
  }

  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(0, data.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM tag verification failure (tampered ciphertext or wrong key) throws
    // here — Node gives no further detail, which is fine, see DecryptionError.
    throw new DecryptionError("Ciphertext failed authentication — tampered or wrong key");
  }
}

/** Convenience wrapper for the common case of decrypting back to UTF-8 text. */
export function decryptToString(key: Buffer, payload: string): string {
  return decrypt(key, payload).toString("utf8");
}
