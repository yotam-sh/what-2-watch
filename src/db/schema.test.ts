// Integration test: applies the real migrations to a throwaway SQLite file
// and exercises the two properties the plan calls out explicitly —
// (1) the stored Plex token is opaque to a direct DB read, and (2) deleting
// a user cascades to its dependent rows (plex_links here) rather than
// leaving orphans, per the "account deletion must actually delete"
// requirement. Also covers the Plex-only login model's own invariant:
// plex_account_id is the unique identity key now that there's no username.
import { randomBytes, randomUUID } from "node:crypto";
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
import { plexLinks, plexSelectedServers, users } from "./schema";

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

  it("plex_selected_servers rejects selecting the same server twice for one user", () => {
    const user = db
      .insert(users)
      .values({
        plexAccountId: "dup-selection-check",
        plexUsername: "dup-selection-check",
        plexEmail: "dup-selection-check@example.com",
      })
      .returning()
      .get();

    db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "server-x" }).run();

    expect(() =>
      db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "server-x" }).run(),
    ).toThrow();
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

// ---------------------------------------------------------------------------
// Migration 0004_plex_server_selection's backfill, tested against the raw
// SQL files rather than through drizzle's typed API: the point is to prove
// that a pre-picker `plex_links` row (which still had machine_identifier/
// cached_connection_uri/connection_checked_at columns) survives the
// migration as an explicit plex_selected_servers row on the SAME server,
// not as a silently-dropped selection — the exact "existing rows must keep
// working" requirement. Migrations 0000-0003 are applied by hand first (via
// raw sqlite.exec, since "--> statement-breakpoint" lines are plain SQL
// comments and every migration file is otherwise valid multi-statement SQL)
// so a legacy row can be seeded in the schema shape that existed before this
// feature, before 0004 itself is applied on top.
// ---------------------------------------------------------------------------
describe("migration 0004_plex_server_selection backfill", () => {
  const migDir = path.join(__dirname, "migrations");
  let backfillDir: string;
  let raw: Database.Database;

  beforeAll(() => {
    backfillDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-backfill-test-"));
    raw = new Database(path.join(backfillDir, "test.db"));
    applySqlcipherKey(raw, env.SERVER_ENCRYPTION_KEY);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");

    const journal = JSON.parse(
      fs.readFileSync(path.join(migDir, "meta", "_journal.json"), "utf-8"),
    ) as { entries: { tag: string }[] };
    const preTags = journal.entries
      .map((e) => e.tag)
      .filter((tag) => tag !== "0004_plex_server_selection");
    for (const tag of preTags) {
      raw.exec(fs.readFileSync(path.join(migDir, `${tag}.sql`), "utf-8"));
    }
  });

  afterAll(() => {
    raw.close();
    fs.rmSync(backfillDir, { recursive: true, force: true });
  });

  it("copies an already-synced user's machine_identifier + connection cache into plex_selected_servers, and leaves a never-synced link alone", () => {
    const syncedUserId = randomUUID();
    const machineId = "legacy-machine-abc";
    const cachedUri = "https://old-server.example:32400";
    const checkedAtMs = Date.now() - 60_000;

    raw
      .prepare(
        `INSERT INTO users (id, plex_account_id, plex_username, plex_email, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(syncedUserId, "backfill-synced", "backfill-synced", "backfill-synced@example.com", Date.now());
    raw
      .prepare(
        `INSERT INTO plex_links (id, user_id, client_identifier, token_ciphertext, key_scope, machine_identifier, cached_connection_uri, connection_checked_at, created_at)
         VALUES (?, ?, ?, ?, 'server', ?, ?, ?, ?)`,
      )
      .run(randomUUID(), syncedUserId, "client-synced", "v1:legacy:ciphertext", machineId, cachedUri, checkedAtMs, Date.now());

    // A user who linked Plex but never synced (no server was ever chosen
    // for them yet) — machine_identifier is NULL, same as a fresh link.
    const neverSyncedUserId = randomUUID();
    raw
      .prepare(
        `INSERT INTO users (id, plex_account_id, plex_username, plex_email, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(neverSyncedUserId, "backfill-never-synced", "backfill-never-synced", "backfill-never-synced@example.com", Date.now());
    raw
      .prepare(
        `INSERT INTO plex_links (id, user_id, client_identifier, token_ciphertext, key_scope, machine_identifier, cached_connection_uri, connection_checked_at, created_at)
         VALUES (?, ?, ?, ?, 'server', NULL, NULL, NULL, ?)`,
      )
      .run(randomUUID(), neverSyncedUserId, "client-never-synced", "v1:legacy:ciphertext2", Date.now());

    // Apply the migration under test.
    raw.exec(fs.readFileSync(path.join(migDir, "0004_plex_server_selection.sql"), "utf-8"));

    const syncedSelection = raw
      .prepare(`SELECT * FROM plex_selected_servers WHERE user_id = ?`)
      .all(syncedUserId) as { machine_identifier: string; cached_connection_uri: string; connection_checked_at: number }[];
    expect(syncedSelection).toHaveLength(1);
    expect(syncedSelection[0].machine_identifier).toBe(machineId);
    expect(syncedSelection[0].cached_connection_uri).toBe(cachedUri);
    expect(syncedSelection[0].connection_checked_at).toBe(checkedAtMs);

    const neverSyncedSelection = raw
      .prepare(`SELECT * FROM plex_selected_servers WHERE user_id = ?`)
      .all(neverSyncedUserId);
    expect(neverSyncedSelection).toHaveLength(0);

    // The single-server fields are actually gone from plex_links now, not
    // just unused.
    const linkColumns = (raw.prepare(`PRAGMA table_info(plex_links)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(linkColumns).not.toContain("machine_identifier");
    expect(linkColumns).not.toContain("cached_connection_uri");
    expect(linkColumns).not.toContain("connection_checked_at");
  });
});
