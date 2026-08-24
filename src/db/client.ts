// ---------------------------------------------------------------------------
// Single shared SQLite connection for the whole app.
//
// The whole file is encrypted at rest via SQLCipher (through
// `better-sqlite3-multiple-ciphers`, an API-compatible drop-in for
// `better-sqlite3` with the cipher codec built into the native addon) — see
// sqlcipherKey.ts. Per-column encryption was rejected because `tmdb_id` must
// stay indexable/joinable in plaintext for the recommender; whole-database
// encryption covers `watch_events`, ratings, and the Letterboxd handle
// without giving that up.
//
// The key MUST be applied before any other statement — see sqlcipherKey.ts
// for why. WAL mode lets readers and writers proceed without blocking each
// other, which matters once background sync jobs run concurrently with
// user-facing requests; `foreign_keys` is OFF by default on every new SQLite
// connection regardless of what's in the file. Both must be (re-)applied
// per connection, and both only make sense *after* the key, since neither
// pragma can do anything useful against an unkeyed encrypted handle.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "@/lib/env";
import { applySqlcipherKey } from "./sqlcipherKey";
import * as schema from "./schema";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);

// First statement on this handle, full stop — see sqlcipherKey.ts.
applySqlcipherKey(sqlite, env.SERVER_ENCRYPTION_KEY);

try {
  // The first pragma that actually touches the file's pages after keying.
  // If the key is wrong, SQLCipher can't verify the page HMAC and reports
  // it identically to a corrupt file: "file is not a database". That's
  // indistinguishable from real corruption unless we intercept it here —
  // left alone it's a baffling error at 2am, so translate it into the one
  // actionable explanation this failure mode actually has.
  sqlite.pragma("journal_mode = WAL");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("file is not a database")) {
    // Deliberately a brand-new Error with a static message — never forward
    // `err` or anything derived from the key/pragma into this, per the
    // "never log the key" rule in sqlcipherKey.ts.
    throw new Error(
      `Cannot open ${DB_PATH}: the encryption key was rejected. This almost always ` +
        "means SERVER_ENCRYPTION_KEY is missing, was changed, or doesn't match the " +
        "key this database file was created with — SQLCipher reports a wrong key " +
        "identically to file corruption. If this is dev data you don't need, delete " +
        "data/app.db* and re-run migrations. If it's a real database, restore the " +
        "original SERVER_ENCRYPTION_KEY (see README: 'Encryption at rest').",
    );
  }
  throw err;
}

sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

/** Exposed for the health check and for tests that need to close the handle. */
export { sqlite };
