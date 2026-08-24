// ---------------------------------------------------------------------------
// Applies the SQLCipher encryption key to a freshly-opened connection.
//
// `better-sqlite3-multiple-ciphers` defaults to its own "sqleet"-style
// ChaCha20 cipher, not SQLCipher's AES scheme — `cipher='sqlcipher'` has to
// be selected explicitly before the key is set, or the raw-key form below
// would be interpreted by the wrong codec.
//
// Order is load-bearing: `PRAGMA cipher` and `PRAGMA key` must be the first
// two statements issued against the handle, before WAL/foreign_keys or any
// query. SQLCipher derives the per-page cipher lazily from whatever it reads
// first, so a statement issued before keying either errors outright or
// silently runs against pages it can't actually decrypt.
//
// The key is passed in the raw-key form — `key = "x'<64 hex chars>'"` —
// rather than as a passphrase string. A passphrase would make SQLCipher run
// its own PBKDF2 over it to derive the real key; SERVER_ENCRYPTION_KEY is
// already 32 bytes of random key material (see src/lib/env.ts), so that KDF
// pass would add cost without adding security, and would make the encrypted
// bytes on disk depend on a KDF/iteration-count choice we'd then have to
// pin forever. Using the raw bytes directly is simpler and just as strong.
//
// NEVER log `keyBase64`, the derived hex, or the assembled pragma string —
// including in an error message. A caught error here must only ever surface
// a static, hand-written message (see client.ts), never `err.message` or the
// pragma text itself.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3-multiple-ciphers";

export function applySqlcipherKey(sqlite: Database.Database, keyBase64: string): void {
  const keyHex = Buffer.from(keyBase64, "base64").toString("hex");
  sqlite.pragma("cipher='sqlcipher'");
  sqlite.pragma(`key="x'${keyHex}'"`);
}
