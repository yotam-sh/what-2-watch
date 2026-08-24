// ---------------------------------------------------------------------------
// Integration tests for backfill.ts's DB-writing / priority-ordering /
// resumability logic — same throwaway-migrated-SQLite approach as
// src/lib/plex/librarySync.test.ts and src/lib/ml/recommend.test.ts (mocking
// @/db/client), combined with client.test.ts's mocked-global.fetch approach
// so no real TMDB key or network call is ever needed.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-tmdb-backfill-test-"));
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

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  // Full isolation between tests: backfillTmdbEnrichment({}) with no limit
  // sweeps up EVERY unenriched title in the DB by design (that's the whole
  // point of resumability), so a leftover stub from a previous test would
  // silently get pulled into the next test's run and skew its counts. users
  // cascade-deletes plex_items/watch_events/watchlist_items; titles has no
  // cascade (deliberately — see schema.ts), so it's cleared explicitly,
  // after those child rows are gone, to avoid an FK violation.
  testDb.delete(schema.users).run();
  testDb.delete(schema.titles).run();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

let userCounter = 0;
function makeUser(): string {
  userCounter += 1;
  const handle = `tmdb-backfill-user-${userCounter}`;
  const row = testDb
    .insert(schema.users)
    .values({ plexAccountId: handle, plexUsername: handle, plexEmail: `${handle}@example.com` })
    .returning()
    .get();
  return row.id;
}

function makeStub(tmdbId: number, mediaType: "movie" | "tv", title: string) {
  testDb.insert(schema.titles).values({ tmdbId, mediaType, title }).run();
}

/** Extracts the tmdbId path segment from a mocked fetch call's URL, so tests
 *  can assert on *which* title a given fetch call was for. */
function tmdbIdFromCall(callIndex: number): number {
  const [urlArg] = vi.mocked(global.fetch).mock.calls[callIndex]!;
  const url = new URL(String(urlArg));
  const segments = url.pathname.split("/").filter(Boolean); // ["3", mediaType, id]
  return Number(segments[2]);
}

function tmdbDetailsResponse(id: number, status = 200) {
  return new Response(
    JSON.stringify({ id, title: `Title ${id}`, release_date: "2020-01-01", genres: [] }),
    { status },
  ) as unknown as Response;
}

describe("backfillTmdbEnrichment", () => {
  it("only selects unenriched titles, and skips already-enriched ones entirely", async () => {
    const { backfillTmdbEnrichment } = await import("./backfill");

    makeStub(1001, "movie", "Unenriched");
    testDb
      .insert(schema.titles)
      .values({ tmdbId: 1002, mediaType: "movie", title: "Already Enriched", genres: JSON.stringify(["Drama"]) })
      .run();

    vi.mocked(global.fetch).mockImplementation(async (url) => tmdbDetailsResponse(tmdbIdFromUrl(url)));

    const result = await backfillTmdbEnrichment({});

    expect(result.done).toBe(1);
    expect(result.skipped).toBe(0);
    // Only the unenriched title's id was ever fetched.
    const fetchedIds = vi.mocked(global.fetch).mock.calls.map((_, i) => tmdbIdFromCall(i));
    expect(fetchedIds).toEqual([1001]);

    const enriched = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 1001), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(enriched?.genres).not.toBeNull();

    const untouched = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 1002), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(untouched?.genres).toBe(JSON.stringify(["Drama"]));
  });

  it("enriches in priority order: watch_events, then watchlist_items, then discover-pool plex_items", async () => {
    const { backfillTmdbEnrichment } = await import("./backfill");
    const userId = makeUser();

    // Deliberately stubbed/inserted in reverse-priority order, so passing
    // only proves the backfill re-orders them, not that it happened to
    // preserve insertion order.
    makeStub(3003, "movie", "Discover Pool Title"); // plex_items view_count=0 only
    testDb
      .insert(schema.plexItems)
      .values({
        userId,
        machineIdentifier: "server-1",
        ratingKey: "rk-3003",
        tmdbId: 3003,
        mediaType: "movie",
        viewCount: 0,
      })
      .run();

    makeStub(2002, "movie", "Watchlist Title");
    testDb
      .insert(schema.watchlistItems)
      .values({ userId, tmdbId: 2002, mediaType: "movie", addedAt: new Date() })
      .run();

    makeStub(1001, "movie", "Watched Title");
    testDb
      .insert(schema.watchEvents)
      .values({ userId, tmdbId: 1001, mediaType: "movie", source: "plex", watchedAt: new Date() })
      .run();

    vi.mocked(global.fetch).mockImplementation(async (url) => tmdbDetailsResponse(tmdbIdFromUrl(url)));

    // batchSize covers all 3 in one DB pull; concurrency >= 3 so all 3 fetch
    // calls dispatch (in priority order) before any of them resolves.
    const result = await backfillTmdbEnrichment({ batchSize: 10, concurrency: 5 });

    expect(result.done).toBe(3);
    const fetchedIds = vi.mocked(global.fetch).mock.calls.map((_, i) => tmdbIdFromCall(i));
    expect(fetchedIds).toEqual([1001, 2002, 3003]);
  });

  it("--limit caps a single run, and a second run resumes with only what remains (no duplicate fetches)", async () => {
    const { backfillTmdbEnrichment } = await import("./backfill");

    makeStub(4001, "movie", "A");
    makeStub(4002, "movie", "B");
    makeStub(4003, "movie", "C");

    vi.mocked(global.fetch).mockImplementation(async (url) => tmdbDetailsResponse(tmdbIdFromUrl(url)));

    const first = await backfillTmdbEnrichment({ limit: 1 });
    expect(first.done).toBe(1);
    expect(first.skipped).toBe(0);

    const enrichedAfterFirst = testDb
      .select()
      .from(schema.titles)
      .where(eq(schema.titles.mediaType, "movie"))
      .all()
      .filter((t) => t.tmdbId >= 4001 && t.tmdbId <= 4003 && t.genres != null);
    expect(enrichedAfterFirst).toHaveLength(1);

    const second = await backfillTmdbEnrichment({});
    expect(second.done).toBe(2); // only the two that remained

    // No title was ever fetched twice across both runs.
    const allFetchedIds = vi.mocked(global.fetch).mock.calls.map((_, i) => tmdbIdFromCall(i));
    expect(new Set(allFetchedIds).size).toBe(allFetchedIds.length);
    expect(allFetchedIds).toHaveLength(3);
  });

  it("a 429 with Retry-After is retried (via client.ts's tmdbGet) rather than dropping the title", async () => {
    const { backfillTmdbEnrichment } = await import("./backfill");

    makeStub(5001, "movie", "Rate Limited Then OK");

    let calls = 0;
    vi.mocked(global.fetch).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "0" } }) as unknown as Response;
      }
      return tmdbDetailsResponse(5001);
    });

    const result = await backfillTmdbEnrichment({});

    expect(result.done).toBe(1);
    expect(result.skipped).toBe(0);
    expect(calls).toBe(2); // one 429, one successful retry

    const row = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 5001), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(row?.genres).not.toBeNull();
  });

  it("a title that fails permanently is counted as skipped and doesn't block the rest of the batch", async () => {
    const { backfillTmdbEnrichment } = await import("./backfill");

    makeStub(6001, "movie", "Will 404");
    makeStub(6002, "movie", "Will Succeed");

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const id = tmdbIdFromUrl(url);
      if (id === 6001) return new Response("", { status: 404 }) as unknown as Response;
      return tmdbDetailsResponse(id);
    });

    const result = await backfillTmdbEnrichment({});

    expect(result.done).toBe(1);
    expect(result.skipped).toBe(1);

    const failed = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 6001), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(failed?.genres).toBeNull();
  });

  it("reports progress with done/skipped/remaining", async () => {
    const { backfillTmdbEnrichment } = await import("./backfill");

    makeStub(7001, "movie", "A");
    makeStub(7002, "movie", "B");

    vi.mocked(global.fetch).mockImplementation(async (url) => tmdbDetailsResponse(tmdbIdFromUrl(url)));

    const progressCalls: Array<{ done: number; skipped: number; remaining: number }> = [];
    await backfillTmdbEnrichment({ onProgress: (p) => progressCalls.push(p) });

    expect(progressCalls.length).toBeGreaterThan(0);
    const last = progressCalls[progressCalls.length - 1]!;
    expect(last.done).toBe(2);
    expect(last.remaining).toBe(0);
  });
});

function tmdbIdFromUrl(url: string | URL | Request): number {
  const u = new URL(String(url instanceof Request ? url.url : url));
  const segments = u.pathname.split("/").filter(Boolean);
  return Number(segments[2]);
}
