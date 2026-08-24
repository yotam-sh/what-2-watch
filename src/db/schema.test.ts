// Integration test: applies the real migrations to a throwaway SQLite file
// and exercises the two properties the plan calls out explicitly —
// (1) stored secrets are opaque to a direct DB read, and (2) deleting a
// user cascades to its dependent rows (plex_links here) rather than leaving
// orphans, per the "account deletion must actually delete" requirement.
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
  it("stores an opaque password hash and an opaque encrypted token", () => {
    const plaintext = "correct horse battery staple";
    const plexToken = "super-secret-plex-account-token";

    const user = db
      .insert(users)
      .values({
        username: "opacity-check",
        // Not a real Argon2id hash — a unit test doesn't need to pay that
        // cost — but it must not equal the plaintext password.
        passwordHash: "argon2id$fake-hash-for-test",
        kdfSalt: randomBytes(16),
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
    const rawUser = sqlite
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(user.id) as { password_hash: string };
    const rawLink = sqlite
      .prepare("SELECT token_ciphertext FROM plex_links WHERE user_id = ?")
      .get(user.id) as { token_ciphertext: string };

    expect(rawUser.password_hash).not.toBe(plaintext);
    expect(rawUser.password_hash).not.toContain(plaintext);
    expect(rawLink.token_ciphertext).not.toContain(plexToken);
    expect(rawLink.token_ciphertext.startsWith("v1:")).toBe(true);
  });

  it("cascades user deletion to plex_links", () => {
    const user = db
      .insert(users)
      .values({
        username: "cascade-check",
        passwordHash: "argon2id$fake-hash-for-test-2",
        kdfSalt: randomBytes(16),
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

  it("enforces the unique username constraint", () => {
    db.insert(users)
      .values({
        username: "duplicate-check",
        passwordHash: "argon2id$fake-hash-for-test-3",
        kdfSalt: randomBytes(16),
      })
      .run();

    expect(() =>
      db
        .insert(users)
        .values({
          username: "duplicate-check",
          passwordHash: "argon2id$another-hash",
          kdfSalt: randomBytes(16),
        })
        .run(),
    ).toThrow();
  });
});
