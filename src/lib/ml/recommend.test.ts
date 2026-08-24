// Integration test for the DB-facing orchestration layer (recommend.ts,
// which — like reconcile.ts/cf.ts/ltr.ts — imports the shared `db` singleton
// from @/db/client rather than taking it as a parameter). Rather than
// hitting the real dev database at ./data/app.db, this mocks @/db/client to
// point at a throwaway, real, migrated SQLCipher-encrypted SQLite file —
// same approach src/db/schema.test.ts uses for its own DB-backed
// assertions, just wired through vi.mock so recommend.ts's (and
// reconcile.ts's/cf.ts's/ltr.ts's) existing `import { db } from
// "@/db/client"` resolves to it transparently.
//
// This is what exercises the plan's explicit cold-start requirement
// end-to-end: "a user with zero history returns sensible non-empty results
// and does not throw" is not fully verifiable from score.ts's pure
// functions alone, because it also depends on recommend.ts actually
// building a non-empty candidate pool and not blowing up when
// getCfScoresForUser()/loadLtrModel() come back null.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applySqlcipherKey } from "@/db/sqlcipherKey";
import * as schema from "@/db/schema";
import { env } from "@/lib/env";

let dir: string;
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/db/client", () => ({
  get db() {
    return testDb;
  },
  get sqlite() {
    return sqlite;
  },
}));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-recommend-test-"));
  const dbPath = path.join(dir, "test.db");
  sqlite = new Database(dbPath);
  applySqlcipherKey(sqlite, env.SERVER_ENCRYPTION_KEY);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(__dirname, "..", "..", "db", "migrations") });
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Plex-only login (schema revised 2026-08-24, concurrent with this phase):
// users are keyed by plexAccountId rather than username/password. `username`
// here is just this test file's existing per-test unique handle — reused as
// the (unique) plexAccountId so every test's makeUser() call still gets its
// own isolated user row.
function makeUser(username: string): string {
  const row = testDb
    .insert(schema.users)
    .values({
      plexAccountId: username,
      plexUsername: username,
      plexEmail: `${username}@example.com`,
    })
    .returning()
    .get();
  return row.id;
}

function makeTitle(t: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  runtime?: number;
  genres?: string[];
}) {
  testDb
    .insert(schema.titles)
    .values({
      tmdbId: t.tmdbId,
      mediaType: t.mediaType,
      title: t.title,
      year: t.year,
      runtime: t.runtime,
      genres: JSON.stringify(t.genres ?? []),
      directors: JSON.stringify([]),
      cast: JSON.stringify([]),
      keywords: JSON.stringify([]),
      overview: `Overview of ${t.title}`,
    })
    .run();
}

describe("recommend() — cold start (constraint 23)", () => {
  it("returns non-empty, non-throwing results for a brand-new user with zero history", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("cold-start-user");
    makeTitle({ tmdbId: 1, mediaType: "movie", title: "Alpha", year: 2000, runtime: 100, genres: ["Drama"] });
    makeTitle({ tmdbId: 2, mediaType: "movie", title: "Beta", year: 2001, runtime: 110, genres: ["Comedy"] });
    makeTitle({ tmdbId: 3, mediaType: "movie", title: "Gamma", year: 2002, runtime: 95, genres: ["Action"] });

    const results = recommend(userId, { mode: "discover" });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => typeof r.score === "number" && Number.isFinite(r.score))).toBe(true);
  });

  it("never throws when a mode's candidate pool is genuinely empty for this user (e.g. 'continue' with no in-progress Plex items)", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("cold-start-no-continue");
    // Titles exist in the shared catalog (other tests in this file add
    // some), but this brand-new user has no plex_items rows at all, so
    // "continue" (in-progress via viewOffset) must legitimately come back
    // empty — that's correct behavior, not a bug, and must not throw.
    expect(() => recommend(userId, { mode: "continue" })).not.toThrow();
    expect(recommend(userId, { mode: "continue" })).toEqual([]);
  });

  it("CF/LTR being untrained does not affect the result — falls back to content-only cleanly", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("cold-start-no-cf-ltr");
    makeTitle({ tmdbId: 10, mediaType: "movie", title: "Delta", year: 2010, runtime: 100, genres: ["Drama"] });
    // No cf_user_factors / ltr_models rows exist for this user anywhere in
    // the DB — getCfScoresForUser/loadLtrModel must both return null
    // internally, and recommend() must still produce a result rather than
    // erroring or returning nothing.
    const results = recommend(userId, { mode: "discover" });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("recommend() — mode candidate pools", () => {
  it("watchlist mode only returns titles on the user's watchlist", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("watchlist-user");
    makeTitle({ tmdbId: 20, mediaType: "movie", title: "OnList", year: 2015, runtime: 100 });
    makeTitle({ tmdbId: 21, mediaType: "movie", title: "NotOnList", year: 2016, runtime: 100 });
    testDb
      .insert(schema.watchlistItems)
      .values({ userId, tmdbId: 20, mediaType: "movie", addedAt: new Date() })
      .run();

    const results = recommend(userId, { mode: "watchlist" });
    expect(results.map((r) => r.tmdbId)).toEqual([20]);
  });

  it("rewatch mode requires plex view_count >= 1", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("rewatch-user");
    makeTitle({ tmdbId: 30, mediaType: "movie", title: "Watched", year: 2015, runtime: 100 });
    makeTitle({ tmdbId: 31, mediaType: "movie", title: "NeverWatched", year: 2016, runtime: 100 });
    testDb
      .insert(schema.plexItems)
      .values({
        userId,
        machineIdentifier: "server-1",
        ratingKey: "rk-30",
        tmdbId: 30,
        mediaType: "movie",
        type: 1,
        viewCount: 2,
      })
      .run();

    const results = recommend(userId, { mode: "rewatch" });
    expect(results.map((r) => r.tmdbId)).toEqual([30]);
  });

  it("discover mode excludes titles already in the reconciled watch history", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("discover-user");
    makeTitle({ tmdbId: 40, mediaType: "movie", title: "AlreadySeen", year: 2015, runtime: 100 });
    makeTitle({ tmdbId: 41, mediaType: "movie", title: "Fresh", year: 2016, runtime: 100 });
    testDb
      .insert(schema.watchEvents)
      .values({ userId, tmdbId: 40, mediaType: "movie", source: "letterboxd", watchedAt: new Date() })
      .run();

    const results = recommend(userId, { mode: "discover" });
    expect(results.map((r) => r.tmdbId)).not.toContain(40);
    expect(results.map((r) => r.tmdbId)).toContain(41);
  });

  it("discover mode draws from the synced Plex library pool (view_count = 0) once one exists, excluding watched library items and titles outside the library entirely", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("discover-library-user");
    makeTitle({ tmdbId: 50, mediaType: "movie", title: "OwnedUnwatched", year: 2018, runtime: 100 });
    makeTitle({ tmdbId: 51, mediaType: "movie", title: "OwnedWatched", year: 2019, runtime: 100 });
    makeTitle({ tmdbId: 52, mediaType: "movie", title: "NotInLibrary", year: 2020, runtime: 100 });
    testDb
      .insert(schema.plexItems)
      .values([
        {
          userId,
          machineIdentifier: "server-1",
          ratingKey: "rk-50",
          tmdbId: 50,
          mediaType: "movie",
          type: 1,
          viewCount: 0,
        },
        {
          userId,
          machineIdentifier: "server-1",
          ratingKey: "rk-51",
          tmdbId: 51,
          mediaType: "movie",
          type: 1,
          viewCount: 3,
        },
      ])
      .run();

    const results = recommend(userId, { mode: "discover" });
    const ids = results.map((r) => r.tmdbId);
    // Only the unwatched library item is a candidate — a title synced with a
    // real view_count is excluded (it's been watched), and a title that was
    // never in the Plex library at all doesn't get pulled in just because
    // it happens to be unwatched too, once a real library pool exists.
    expect(ids).toContain(50);
    expect(ids).not.toContain(51);
    expect(ids).not.toContain(52);
  });

  it("discover mode still excludes a library item's reconciled watch (e.g. watched on Letterboxd, not yet reflected in Plex view_count)", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("discover-library-letterboxd-user");
    makeTitle({ tmdbId: 60, mediaType: "movie", title: "OwnedButSeenElsewhere", year: 2017, runtime: 100 });
    testDb
      .insert(schema.plexItems)
      .values({
        userId,
        machineIdentifier: "server-1",
        ratingKey: "rk-60",
        tmdbId: 60,
        mediaType: "movie",
        type: 1,
        viewCount: 0,
      })
      .run();
    testDb
      .insert(schema.watchEvents)
      .values({ userId, tmdbId: 60, mediaType: "movie", source: "letterboxd", watchedAt: new Date() })
      .run();

    const results = recommend(userId, { mode: "discover" });
    expect(results.map((r) => r.tmdbId)).not.toContain(60);
  });
});

describe("recommend() — determinism", () => {
  it("the same explicit seed reproduces the same ranked order ('roll again')", async () => {
    const { recommend } = await import("./recommend");
    const userId = makeUser("seed-user");
    for (let i = 100; i < 108; i++) {
      makeTitle({ tmdbId: i, mediaType: "movie", title: `Title ${i}`, year: 2000, runtime: 100 });
    }
    const a = recommend(userId, { mode: "discover", seed: 555 });
    const b = recommend(userId, { mode: "discover", seed: 555 });
    expect(a.map((r) => r.tmdbId)).toEqual(b.map((r) => r.tmdbId));
  });
});
