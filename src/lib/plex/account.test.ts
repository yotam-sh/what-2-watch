// Find-or-create by Plex account identity, and the token-linking step that
// follows it — the core of "linking and signing in are now the same
// action." Same throwaway-migrated-DB-behind-a-mocked-@/db/client approach
// as src/lib/auth/guards.test.ts, since account.ts imports the shared db
// client directly.
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { decryptWithServerVault } from "@/lib/crypto/serverVault";
import type { PlexAccountIdentity } from "./pin";

vi.mock("@/db/client", async () => {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const Database = (await import("better-sqlite3-multiple-ciphers")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-account-test-"));
  const sqlite = new Database(path.join(dir, "test.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "db", "migrations") });

  return { db, sqlite };
});

function identity(overrides: Partial<PlexAccountIdentity> = {}): PlexAccountIdentity {
  return {
    id: "plex-acc-1",
    username: "yotam",
    email: "yotam@example.com",
    thumb: null,
    ...overrides,
  };
}

describe("findOrCreateUser / linkPlexToken", () => {
  afterAll(async () => {
    const { sqlite } = await import("@/db/client");
    sqlite.close();
  });

  it("creates a new user on first sign-in", async () => {
    const { findOrCreateUser } = await import("./account");
    const { db } = await import("@/db/client");
    const { users } = await import("@/db/schema");

    const user = findOrCreateUser(identity({ id: "new-user-acc" }));

    expect(user.plexAccountId).toBe("new-user-acc");
    expect(user.plexUsername).toBe("yotam");
    const rows = db.select().from(users).where(eq(users.plexAccountId, "new-user-acc")).all();
    expect(rows).toHaveLength(1);
  });

  it("finds the same user on a second sign-in with the same plex_account_id, refreshing display fields", async () => {
    const { findOrCreateUser } = await import("./account");
    const { db } = await import("@/db/client");
    const { users } = await import("@/db/schema");

    const first = findOrCreateUser(identity({ id: "returning-acc", username: "old-name" }));
    const second = findOrCreateUser(
      identity({ id: "returning-acc", username: "new-name", email: "new-email@example.com" }),
    );

    expect(second.id).toBe(first.id); // same user row, not a duplicate
    expect(second.plexUsername).toBe("new-name");
    expect(second.plexEmail).toBe("new-email@example.com");

    const rows = db.select().from(users).where(eq(users.plexAccountId, "returning-acc")).all();
    expect(rows).toHaveLength(1);
  });

  it("writes a fresh plex_links row with key_scope='server', decryptable via serverVault", async () => {
    const { findOrCreateUser, linkPlexToken } = await import("./account");
    const { db } = await import("@/db/client");
    const { plexLinks } = await import("@/db/schema");

    const user = findOrCreateUser(identity({ id: "link-acc-1" }));
    linkPlexToken(user.id, { token: "real-plex-token", freshClientIdentifier: "client-abc" });

    const link = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();
    expect(link).toBeDefined();
    expect(link!.keyScope).toBe("server");
    expect(link!.clientIdentifier).toBe("client-abc");
    expect(link!.tokenCiphertext).not.toContain("real-plex-token");
    expect(decryptWithServerVault(link!.tokenCiphertext)).toBe("real-plex-token");
  });

  it("re-linking a returning user keeps the already-persisted client_identifier (constraint 3), not the fresh one from this login", async () => {
    const { findOrCreateUser, linkPlexToken } = await import("./account");
    const { db } = await import("@/db/client");
    const { plexLinks } = await import("@/db/schema");

    const user = findOrCreateUser(identity({ id: "link-acc-2" }));
    linkPlexToken(user.id, { token: "first-token", freshClientIdentifier: "original-client-id" });

    // A later login mints a brand new client identifier (unauthenticated
    // start — see src/app/api/auth/plex/start) before we know it's the same
    // returning user.
    linkPlexToken(user.id, { token: "second-token", freshClientIdentifier: "brand-new-client-id" });

    const link = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();
    expect(link!.clientIdentifier).toBe("original-client-id");
    expect(decryptWithServerVault(link!.tokenCiphertext)).toBe("second-token");

    const allLinks = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).all();
    expect(allLinks).toHaveLength(1); // updated in place, not duplicated
  });
});
