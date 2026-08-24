// ---------------------------------------------------------------------------
// userVault — the per-user encryption scope.
//
// Key = Argon2id(password, users.kdf_salt). This key exists only in memory,
// for the lifetime of a logged-in session (see src/lib/auth/sessionStore.ts)
// — it is never persisted anywhere. That's the entire point of this scope:
// a Plex token encrypted under it is unrecoverable to the server while its
// owner is logged out, and permanently unrecoverable if the password is
// forgotten. The UI must say so before a user links Plex (see plan, Security
// specifics).
//
// kdf_salt is a separate random value from whatever Argon2id embeds in
// password_hash (see schema.ts users table comment) — never derive an
// encryption key from a value that's also used to verify a password.
//
// Params target ~500ms on the deploy target's CPU per the plan; the numbers
// below are the plan's starting point (m=64MiB, t=3, p=4) and should be
// re-tuned against the actual TrueNAS hardware in Phase 6.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { hashRaw } from "@node-rs/argon2";
import { decrypt, decryptToString, encrypt } from "./aes";

export const KDF_SALT_LENGTH = 16;
const KDF_MEMORY_COST_KIB = 64 * 1024; // 64 MiB
const KDF_TIME_COST = 3;
const KDF_PARALLELISM = 4;
const KDF_OUTPUT_LEN = 32; // AES-256 key length

/** Generates a fresh kdf_salt for a new user row. Called once at signup. */
export function generateKdfSalt(): Buffer {
  return randomBytes(KDF_SALT_LENGTH);
}

/** Derives the AES-256 userVault key from a plaintext password and the
 *  user's stored kdf_salt. Deterministic for the same (password, salt) pair
 *  — that determinism is required, since this must be re-derivable on every
 *  login from just the password the user types in. */
export async function deriveUserVaultKey(password: string, kdfSalt: Buffer): Promise<Buffer> {
  return hashRaw(password, {
    salt: kdfSalt,
    memoryCost: KDF_MEMORY_COST_KIB,
    timeCost: KDF_TIME_COST,
    parallelism: KDF_PARALLELISM,
    outputLen: KDF_OUTPUT_LEN,
  });
}

export function encryptWithUserVault(key: Buffer, plaintext: string): string {
  return encrypt(key, plaintext);
}

export function decryptWithUserVault(key: Buffer, payload: string): string {
  return decryptToString(key, payload);
}

/** Exposed for callers that need raw bytes rather than UTF-8 text. */
export function decryptBufferWithUserVault(key: Buffer, payload: string): Buffer {
  return decrypt(key, payload);
}
