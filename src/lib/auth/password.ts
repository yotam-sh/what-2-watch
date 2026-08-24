// ---------------------------------------------------------------------------
// Password hashing for login verification.
//
// This is deliberately separate from the userVault key derivation in
// src/lib/crypto/userVault.ts, and uses its own randomly-generated salt
// (via @node-rs/argon2's default salt generation) rather than the user's
// `kdf_salt`. Never reuse one salt for both purposes — see the comment on
// `users.kdf_salt` in src/db/schema.ts for why.
// ---------------------------------------------------------------------------

import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

// Same cost params as the plan's KDF target (~500ms on the deploy CPU);
// tune both together if that number ever moves.
const MEMORY_COST_KIB = 64 * 1024; // 64 MiB
const TIME_COST = 3;
const PARALLELISM = 4;

/** Hashes a plaintext password into a PHC-encoded Argon2id string suitable
 *  for storage in users.password_hash. Generates its own random salt. */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, {
    memoryCost: MEMORY_COST_KIB,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
  });
}

/** Verifies a plaintext password against a stored PHC hash. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return argon2Verify(passwordHash, password);
}
