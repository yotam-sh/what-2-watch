// ---------------------------------------------------------------------------
// Decrypts a linked user's Plex token, honouring `plex_links.key_scope`.
//
// 'user' (the default): the token is under the userVault key, which only
// exists in memory for a live session (src/lib/auth/sessionStore.ts). No
// vault key => the caller must treat this as "please log in again", not a
// 500 — same rule sessionStore.ts documents for any userVault consumer.
//
// 'server': the explicit "keep syncing while I'm away" opt-in re-wraps the
// token under SERVER_ENCRYPTION_KEY, decryptable without a live session —
// this is what lets a background sync run for a user who isn't currently
// logged in.
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
