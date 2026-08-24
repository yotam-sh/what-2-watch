// Integration test: applies the real migrations to a throwaway SQLite file
// and exercises the two properties the plan calls out explicitly —
// (1) the stored Plex token is opaque to a direct DB read, and (2) deleting
// a user cascades to its dependent rows (plex_links here) rather than
// leaving orphans, per the "account deletion must actually delete"
// requirement. Also covers the Plex-only login model's own invariant:
// plex_account_id is the unique identity key now that there's no username.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encrypt } from "@/lib/crypto/aes";
import { env } from "@/lib/env";
import { applySqlcipherKey } from "./sqlcipherKey";
import { plexLinks, users } from "./schema";

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-schema-test-"));
  dbPath = path.join(dir, "test.db");
  sqlite = new Database(dbPath);
  // Keyed the same way as the real app (client.ts) — this test opens a real
  // on-disk DB and runs real migrations against it, so it should exercise
  // the same encrypted-at-rest path production uses, not a plaintext one.
  applySqlcipherKey(sqlite, env.SERVER_ENCRYPTION_KEY);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(__dirname, "migrations") });
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("schema migrations", () => {
  it("stores an opaque encrypted Plex token", () => {
    const plexToken = "super-secret-plex-account-token";

    const user = db
      .insert(users)
      .values({
        plexAccountId: "opacity-check",
        plexUsername: "opacity-check",
        plexEmail: "opacity-check@example.com",
      })
      .returning()
      .get();

    const tokenCiphertext = encrypt(randomBytes(32), plexToken);
    db.insert(plexLinks)
      .values({
        userId: user.id,
        clientIdentifier: randomBytes(16).toString("hex"),
        tokenCiphertext,
      })
      .run();

    // Read back with a raw query, bypassing Drizzle's typed helpers, to
    // simulate "someone opens the .db file directly".
    const rawLink = sqlite
      .prepare("SELECT token_ciphertext FROM plex_links WHERE user_id = ?")
      .get(user.id) as { token_ciphertext: string };

    expect(rawLink.token_ciphertext).not.toContain(plexToken);
    expect(rawLink.token_ciphertext.startsWith("v1:")).toBe(true);
  });

  it("writes new plex_links rows with key_scope='server' by default", () => {
    const user = db
      .insert(users)
      .values({
        plexAccountId: "default-scope-check",
        plexUsername: "default-scope-check",
        plexEmail: "default-scope-check@example.com",
      })
      .returning()
      .get();

    const link = db
      .insert(plexLinks)
      .values({
        userId: user.id,
        clientIdentifier: randomBytes(16).toString("hex"),
        tokenCiphertext: encrypt(randomBytes(32), "token"),
        // keyScope deliberately omitted — exercises the column default.
      })
      .returning()
      .get();

    expect(link.keyScope).toBe("server");
  });

  it("cascades user deletion to plex_links", () => {
    const user = db
      .insert(users)
      .values({
        plexAccountId: "cascade-check",
        plexUsername: "cascade-check",
        plexEmail: "cascade-check@example.com",
      })
      .returning()
      .get();

    db.insert(plexLinks)
      .values({
        userId: user.id,
        clientIdentifier: randomBytes(16).toString("hex"),
        tokenCiphertext: encrypt(randomBytes(32), "token"),
      })
      .run();

    expect(db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).all()).toHaveLength(1);

    db.delete(users).where(eq(users.id, user.id)).run();

    expect(db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).all()).toHaveLength(0);
  });

  it("enforces the unique plex_account_id constraint", () => {
    db.insert(users)
      .values({
        plexAccountId: "duplicate-check",
        plexUsername: "duplicate-check",
        plexEmail: "duplicate-check@example.com",
      })
      .run();

    expect(() =>
      db
        .insert(users)
        .values({
          plexAccountId: "duplicate-check",
          plexUsername: "someone-else",
          plexEmail: "someone-else@example.com",
        })
        .run(),
    ).toThrow();
  });
});
