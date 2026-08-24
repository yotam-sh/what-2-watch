// Exercises the guards.ts flow end to end against a real (throwaway, plain
// SQLite — no SQLCipher key needed here, that's schema.test.ts's job)
// migrated DB, with next/headers' cookies() mocked so the cookie jar is
// test-controllable. Covers two things the Plex-only login migration
// specifically claims:
//   1. An unauthenticated request (no cookie) still gets rejected —
//      requireUser() throws, which every server-component page catches and
//      redirects on (see e.g. src/app/settings/page.tsx).
//   2. A signed session JWT resolves identity through nothing but the token
//      + a DB lookup — no in-memory session-store call anywhere in the
//      path. That's what makes a session survive a restart now: there's no
//      second, memory-only half of the session left to lose.
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session_token" && cookieValue ? { value: cookieValue } : undefined),
  }),
}));

vi.mock("@/db/client", async () => {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const Database = (await import("better-sqlite3-multiple-ciphers")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-guards-test-"));
  const sqlite = new Database(path.join(dir, "test.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "db", "migrations") });

  return { db, sqlite };
});

describe("auth guards (Plex-only login)", () => {
  beforeEach(() => {
    cookieValue = undefined;
  });

  afterAll(async () => {
    const { sqlite } = await import("@/db/client");
    sqlite.close();
  });

  it("getOptionalUser returns null with no session cookie", async () => {
    const { getOptionalUser } = await import("./guards");
    expect(await getOptionalUser()).toBeNull();
  });

  it("requireUser throws UnauthenticatedError with no session cookie — this is what protected pages redirect on", async () => {
    const { requireUser, UnauthenticatedError } = await import("./guards");
    await expect(requireUser()).rejects.toThrow(UnauthenticatedError);
  });

  it("a valid session JWT resolves the signed-in Plex user via the DB alone — no session-store lookup", async () => {
    const { db } = await import("@/db/client");
    const { users } = await import("@/db/schema");
    const { signSessionToken } = await import("./jwt");
    const { getOptionalUser } = await import("./guards");

    const user = db
      .insert(users)
      .values({ plexAccountId: "guards-1", plexUsername: "yotam", plexEmail: "yotam@example.com" })
      .returning()
      .get();

    cookieValue = await signSessionToken({ sub: user.id, username: user.plexUsername });

    expect(await getOptionalUser()).toEqual({ id: user.id, username: "yotam" });
  });

  it("a token for a since-deleted user resolves to null rather than trusting stale JWT claims", async () => {
    const { db } = await import("@/db/client");
    const { users } = await import("@/db/schema");
    const { signSessionToken } = await import("./jwt");
    const { getOptionalUser } = await import("./guards");

    const user = db
      .insert(users)
      .values({ plexAccountId: "guards-2", plexUsername: "ghost", plexEmail: "ghost@example.com" })
      .returning()
      .get();
    const token = await signSessionToken({ sub: user.id, username: user.plexUsername });

    db.delete(users).where(eq(users.id, user.id)).run();
    cookieValue = token;

    expect(await getOptionalUser()).toBeNull();
  });
});
