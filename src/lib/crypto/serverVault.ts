// ---------------------------------------------------------------------------
// serverVault — the server-wide encryption scope.
//
// Key = SERVER_ENCRYPTION_KEY env var (base64, 32 bytes — validated in
// src/lib/env.ts). Unlike userVault, this key is available for the entire
// lifetime of the process, so background jobs (Letterboxd polling, embedding
// generation, etc. in later phases) can read/write data encrypted under it
// with no live user session required.
//
// Per the plan, this scope is for *derived* data — watch history rows,
// ratings, the Letterboxd handle — never the raw Plex token. A Plex token
// only ever moves to this scope through the explicit "keep syncing while
// I'm away" opt-in (plex_links.key_scope = 'server'), which re-wraps it
// under this key instead of the user's.
// ---------------------------------------------------------------------------

import { env } from "@/lib/env";
import { decrypt, decryptToString, encrypt } from "./aes";

let cachedKey: Buffer | null = null;

/** Lazily decodes and caches the key. Deferred rather than decoded at module
 *  load so importing this file doesn't itself have a side effect beyond
 *  what env.ts already validated. */
function getServerKey(): Buffer {
  if (!cachedKey) {
    cachedKey = Buffer.from(env.SERVER_ENCRYPTION_KEY, "base64");
  }
  return cachedKey;
}

export function encryptWithServerVault(plaintext: string): string {
  return encrypt(getServerKey(), plaintext);
}

export function decryptWithServerVault(payload: string): string {
  return decryptToString(getServerKey(), payload);
}

/** Exposed for callers that need raw bytes rather than UTF-8 text. */
export function decryptBufferWithServerVault(payload: string): Buffer {
  return decrypt(getServerKey(), payload);
}
