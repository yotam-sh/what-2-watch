// ---------------------------------------------------------------------------
// Integration tests for librarySync.ts's DB-writing orchestration — same
// approach as src/lib/ml/recommend.test.ts (and src/db/schema.test.ts):
// mock @/db/client to point at a throwaway, real, migrated SQLite file
// rather than hitting the real dev database, since upsertMovieWatch/
// upsertShowWatch write through the shared `db` singleton rather than
// taking a connection as a parameter.
//
// Phase 6 focus ("discover pool"): the library-scan functions in library.ts
// are covered by library.test.ts's fixture/HTTP-server tests; what needs
// covering *here*, at the DB layer, is specifically:
//   - an unwatched item (view_count 0, no lastViewedAt) lands in plex_items
//     with view_count = 0 and produces NO watch_events row — nothing was
//     actually watched, so no history may be fabricated (the rewatch logic
//     and LTR training data both depend on watch_events meaning "actually
//     watched").
//   - re-running the same upsert is idempotent: no duplicate plex_items rows
//     (the unique index on user/machine/ratingKey), and it must never
//     "downgrade" a title TMDB has already enriched back to a bare stub.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applySqlcipherKey } from "@/db/sqlcipherKey";
import * as schema from "@/db/schema";
import { env } from "@/lib/env";
import type { NormalizedPlexItem } from "./library";

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-librarysync-test-"));
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

let userCounter = 0;
function makeUser(): string {
  userCounter += 1;
  const handle = `librarysync-user-${userCounter}`;
  const row = testDb
    .insert(schema.users)
    .values({ plexAccountId: handle, plexUsername: handle, plexEmail: `${handle}@example.com` })
    .returning()
    .get();
  return row.id;
}

function movieItem(overrides: Partial<NormalizedPlexItem>): NormalizedPlexItem {
  return {
    ratingKey: "rk-default",
    title: "Some Movie",
    viewCount: 0,
    externalIds: { tmdbId: null, imdbId: null, tvdbId: null },
    ...overrides,
  };
}

function showItem(overrides: Partial<NormalizedPlexItem>): NormalizedPlexItem {
  return {
    ratingKey: "rk-show-default",
    title: "Some Show",
    viewCount: 0,
    externalIds: { tmdbId: null, imdbId: null, tvdbId: null },
    ...overrides,
  };
}

describe("upsertMovieWatch — unwatched items (Phase 6 discover pool)", () => {
  it("writes a plex_items row with view_count = 0 and no watch_events row for a never-watched movie", async () => {
    const { upsertMovieWatch } = await import("./librarySync");
    const userId = makeUser();
    const item = movieItem({
      ratingKey: "rk-100",
      title: "Unwatched Movie",
      viewCount: 0,
      externalIds: { tmdbId: 9001, imdbId: null, tvdbId: null },
    });

    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item });

    const row = testDb
      .select()
      .from(schema.plexItems)
      .where(and(eq(schema.plexItems.userId, userId), eq(schema.plexItems.ratingKey, "rk-100")))
      .get();
    expect(row?.viewCount).toBe(0);
    expect(row?.lastViewedAt).toBeNull();

    const events = testDb
      .select()
      .from(schema.watchEvents)
      .where(and(eq(schema.watchEvents.userId, userId), eq(schema.watchEvents.tmdbId, 9001)))
      .all();
    expect(events).toHaveLength(0);
  });

  it("creates a titles stub for a resolved-but-unwatched movie so the composite FK holds", async () => {
    const { upsertMovieWatch } = await import("./librarySync");
    const userId = makeUser();
    const item = movieItem({
      ratingKey: "rk-101",
      title: "Stub Me",
      year: 2021,
      viewCount: 0,
      externalIds: { tmdbId: 9002, imdbId: null, tvdbId: null },
    });

    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item });

    const title = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 9002), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(title?.title).toBe("Stub Me");
    expect(title?.genres).toBeNull(); // stub, not enriched
  });

  it("re-running the same unwatched item is idempotent — no duplicate plex_items row, still no watch_events", async () => {
    const { upsertMovieWatch } = await import("./librarySync");
    const userId = makeUser();
    const item = movieItem({
      ratingKey: "rk-102",
      title: "Idempotent Movie",
      viewCount: 0,
      externalIds: { tmdbId: 9003, imdbId: null, tvdbId: null },
    });

    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item });
    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item });
    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item });

    const rows = testDb
      .select()
      .from(schema.plexItems)
      .where(and(eq(schema.plexItems.userId, userId), eq(schema.plexItems.ratingKey, "rk-102")))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.viewCount).toBe(0);

    const events = testDb
      .select()
      .from(schema.watchEvents)
      .where(and(eq(schema.watchEvents.userId, userId), eq(schema.watchEvents.tmdbId, 9003)))
      .all();
    expect(events).toHaveLength(0);
  });

  it("does not downgrade a title TMDB has already enriched back to a bare stub", async () => {
    const { upsertMovieWatch } = await import("./librarySync");
    const userId = makeUser();

    // Simulate a prior TMDB enrichment pass (src/lib/tmdb/store.ts's
    // enrichTitle) landing real metadata for this title first.
    testDb
      .insert(schema.titles)
      .values({
        tmdbId: 9004,
        mediaType: "movie",
        title: "Enriched Already",
        genres: JSON.stringify(["Drama"]),
        overview: "A real overview.",
      })
      .run();

    const item = movieItem({
      ratingKey: "rk-103",
      title: "Enriched Already (from Plex, stale title casing)",
      viewCount: 0,
      externalIds: { tmdbId: 9004, imdbId: null, tvdbId: null },
    });
    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item });

    const title = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 9004), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(title?.genres).toBe(JSON.stringify(["Drama"]));
    expect(title?.overview).toBe("A real overview.");
    // The enriched title/overview must survive — the sync must not have
    // overwritten it with the Plex-sourced title text either.
    expect(title?.title).toBe("Enriched Already");
  });

  it("a later real watch still records a watch_events row (view_count and lastViewedAt both flip)", async () => {
    const { upsertMovieWatch } = await import("./librarySync");
    const userId = makeUser();
    const unwatched = movieItem({
      ratingKey: "rk-104",
      title: "Later Watched",
      viewCount: 0,
      externalIds: { tmdbId: 9005, imdbId: null, tvdbId: null },
    });
    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item: unwatched });

    const nowWatched = movieItem({
      ratingKey: "rk-104",
      title: "Later Watched",
      viewCount: 1,
      lastViewedAt: Math.floor(Date.now() / 1000),
      externalIds: { tmdbId: 9005, imdbId: null, tvdbId: null },
    });
    upsertMovieWatch({ userId, machineIdentifier: "server-1", librarySectionId: "1", item: nowWatched });

    const row = testDb
      .select()
      .from(schema.plexItems)
      .where(and(eq(schema.plexItems.userId, userId), eq(schema.plexItems.ratingKey, "rk-104")))
      .get();
    expect(row?.viewCount).toBe(1);
    expect(row?.lastViewedAt).not.toBeNull();

    const events = testDb
      .select()
      .from(schema.watchEvents)
      .where(and(eq(schema.watchEvents.userId, userId), eq(schema.watchEvents.tmdbId, 9005)))
      .all();
    expect(events).toHaveLength(1);
  });
});

describe("upsertShowWatch — unwatched shows (Phase 6 discover pool)", () => {
  it("writes a plex_items row with view_count = 0 and no watch_events row when rollup is undefined (never watched)", async () => {
    const { upsertShowWatch } = await import("./librarySync");
    const userId = makeUser();
    const show = showItem({
      ratingKey: "rk-show-200",
      title: "Unwatched Show",
      leafCount: 10,
      viewedLeafCount: 0,
      externalIds: { tmdbId: 9101, imdbId: null, tvdbId: null },
    });

    upsertShowWatch({ userId, machineIdentifier: "server-1", librarySectionId: "3", show, rollup: undefined });

    const row = testDb
      .select()
      .from(schema.plexItems)
      .where(and(eq(schema.plexItems.userId, userId), eq(schema.plexItems.ratingKey, "rk-show-200")))
      .get();
    expect(row?.viewCount).toBe(0);
    expect(row?.lastViewedAt).toBeNull();
    expect(row?.leafCount).toBe(10);
    expect(row?.viewedLeafCount).toBe(0);

    const events = testDb
      .select()
      .from(schema.watchEvents)
      .where(and(eq(schema.watchEvents.userId, userId), eq(schema.watchEvents.tmdbId, 9101)))
      .all();
    expect(events).toHaveLength(0);
  });

  it("re-running an unwatched show is idempotent — no duplicate plex_items row", async () => {
    const { upsertShowWatch } = await import("./librarySync");
    const userId = makeUser();
    const show = showItem({
      ratingKey: "rk-show-201",
      title: "Idempotent Show",
      leafCount: 5,
      viewedLeafCount: 0,
      externalIds: { tmdbId: 9102, imdbId: null, tvdbId: null },
    });

    upsertShowWatch({ userId, machineIdentifier: "server-1", librarySectionId: "3", show, rollup: undefined });
    upsertShowWatch({ userId, machineIdentifier: "server-1", librarySectionId: "3", show, rollup: undefined });

    const rows = testDb
      .select()
      .from(schema.plexItems)
      .where(and(eq(schema.plexItems.userId, userId), eq(schema.plexItems.ratingKey, "rk-show-201")))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("does not downgrade an already-enriched show title back to a stub", async () => {
    const { upsertShowWatch } = await import("./librarySync");
    const userId = makeUser();
    testDb
      .insert(schema.titles)
      .values({
        tmdbId: 9103,
        mediaType: "tv",
        title: "Enriched Show",
        genres: JSON.stringify(["Comedy"]),
        overview: "Already enriched.",
      })
      .run();

    const show = showItem({
      ratingKey: "rk-show-202",
      title: "Enriched Show (Plex casing)",
      leafCount: 8,
      viewedLeafCount: 0,
      externalIds: { tmdbId: 9103, imdbId: null, tvdbId: null },
    });
    upsertShowWatch({ userId, machineIdentifier: "server-1", librarySectionId: "3", show, rollup: undefined });

    const title = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 9103), eq(schema.titles.mediaType, "tv")))
      .get();
    expect(title?.genres).toBe(JSON.stringify(["Comedy"]));
    expect(title?.title).toBe("Enriched Show");
  });
});
