// ---------------------------------------------------------------------------
// Decrypts a linked user's Plex token, honouring `plex_links.key_scope`.
//
// Plex-only login (revised 2026-08-24): every token this app writes now uses
// 'server' — there is no password any more to derive a 'user'-scope key
// from, and the in-memory session-key store that used to hold it
// (sessionStore.ts) is deleted along with it. The 'user' branch is kept only
// for defensiveness: a row could in principle still say 'user' (e.g. mid a
// real production migration, unlike this dev DB's clean wipe — see the
// 0003 migration's comment), and for that case there is no vault key to be
// had any more, ever, so it always throws VaultKeyUnavailableError. That's
// correct, not a bug: those tokens are permanently unrecoverable by design,
// exactly as documented in userVault.ts (deliberately not deleted — it
// remains the mechanism a future passphrase option would reuse).
// ---------------------------------------------------------------------------

import { decryptWithServerVault } from "@/lib/crypto/serverVault";
import { decryptWithUserVault } from "@/lib/crypto/userVault";

export class VaultKeyUnavailableError extends Error {
  constructor() {
    super("userVault key is unavailable — the user must log in again");
    this.name = "VaultKeyUnavailableError";
  }
}

export function decryptPlexToken(params: {
  keyScope: string;
  tokenCiphertext: string;
  vaultKey: Buffer | undefined;
}): string {
  const { keyScope, tokenCiphertext, vaultKey } = params;
  if (keyScope === "server") {
    return decryptWithServerVault(tokenCiphertext);
  }
  // keyScope === "user" (the schema-level default and only other allowed value).
  if (!vaultKey) {
    throw new VaultKeyUnavailableError();
  }
  return decryptWithUserVault(vaultKey, tokenCiphertext);
}
