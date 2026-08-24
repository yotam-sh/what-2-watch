// ---------------------------------------------------------------------------
// Integration tests for lazyEnrich.ts — same throwaway-migrated-SQLite +
// mocked-fetch approach as backfill.test.ts. What matters here specifically:
// a stub candidate about to be surfaced by /api/recommend gets enriched
// on-the-fly, and a TMDB failure never bubbles up as a thrown error (the
// route degrades to stub data rather than 500ing).
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-lazy-enrich-test-"));
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
  testDb.delete(schema.users).run();
  testDb.delete(schema.titles).run();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeStub(tmdbId: number, mediaType: "movie" | "tv", title: string) {
  testDb.insert(schema.titles).values({ tmdbId, mediaType, title }).run();
}

function candidateFor(tmdbId: number, mediaType: "movie" | "tv", title: string) {
  return { tmdbId, mediaType, title, year: null, runtime: null, posterPath: null };
}

function tmdbIdFromUrl(url: string | URL | Request): number {
  const u = new URL(String(url instanceof Request ? url.url : url));
  const segments = u.pathname.split("/").filter(Boolean);
  return Number(segments[2]);
}

function tmdbDetailsResponse(id: number) {
  return new Response(
    JSON.stringify({
      id,
      title: `Enriched ${id}`,
      release_date: "2019-05-01",
      runtime: 101,
      poster_path: `/poster-${id}.jpg`,
      genres: [{ id: 1, name: "Drama" }],
    }),
    { status: 200 },
  ) as unknown as Response;
}

describe("lazilyEnrichStubCandidates", () => {
  it("enriches a stub candidate on surface and refreshes its display fields", async () => {
    const { lazilyEnrichStubCandidates } = await import("./lazyEnrich");
    makeStub(8001, "movie", "Plex Stub Title");

    vi.mocked(global.fetch).mockImplementation(async (url) => tmdbDetailsResponse(tmdbIdFromUrl(url)));

    const result = await lazilyEnrichStubCandidates([candidateFor(8001, "movie", "Plex Stub Title")]);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("Enriched 8001");
    expect(result[0]!.runtime).toBe(101);
    expect(result[0]!.year).toBe(2019);
    expect(result[0]!.posterPath).toBe("/poster-8001.jpg");

    const row = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 8001), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(row?.genres).toBe(JSON.stringify(["Drama"]));
  });

  it("leaves an already-enriched candidate untouched and never calls TMDB for it", async () => {
    const { lazilyEnrichStubCandidates } = await import("./lazyEnrich");
    testDb
      .insert(schema.titles)
      .values({
        tmdbId: 8002,
        mediaType: "movie",
        title: "Already Enriched",
        genres: JSON.stringify(["Comedy"]),
        runtime: 90,
      })
      .run();

    vi.mocked(global.fetch).mockImplementation(async (url) => tmdbDetailsResponse(tmdbIdFromUrl(url)));

    // recommend.ts already reads fresh data for anything enriched at
    // candidate-generation time, so lazyEnrich has no reason to touch an
    // already-enriched candidate — it passes through exactly as given.
    const input = candidateFor(8002, "movie", "Already Enriched");
    const result = await lazilyEnrichStubCandidates([input]);

    expect(result[0]).toEqual(input);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("degrades gracefully on a TMDB failure — returns the original stub candidate rather than throwing", async () => {
    const { lazilyEnrichStubCandidates } = await import("./lazyEnrich");
    makeStub(8003, "movie", "Will Fail To Enrich");

    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 500 }) as unknown as Response);

    const candidate = candidateFor(8003, "movie", "Will Fail To Enrich");
    await expect(lazilyEnrichStubCandidates([candidate])).resolves.toEqual([candidate]);

    const row = testDb
      .select()
      .from(schema.titles)
      .where(and(eq(schema.titles.tmdbId, 8003), eq(schema.titles.mediaType, "movie")))
      .get();
    expect(row?.genres).toBeNull(); // still a stub
  });

  it("degrades gracefully when TMDB is rate-limited past its retries", async () => {
    const { lazilyEnrichStubCandidates } = await import("./lazyEnrich");
    makeStub(8004, "movie", "Rate Limited Forever");

    vi.mocked(global.fetch).mockResolvedValue(
      new Response("", { status: 429, headers: { "Retry-After": "0" } }) as unknown as Response,
    );

    const candidate = candidateFor(8004, "movie", "Rate Limited Forever");
    const result = await lazilyEnrichStubCandidates([candidate]);
    expect(result).toEqual([candidate]); // still returns results, not an error
  }, 10_000);

  it("bounds enrichment to a handful per call, leaving the rest as stubs", async () => {
    const { MAX_LAZY_ENRICH_PER_REQUEST, lazilyEnrichStubCandidates } = await import("./lazyEnrich");
    const total = MAX_LAZY_ENRICH_PER_REQUEST + 3;
    const candidates = Array.from({ length: total }, (_, i) => {
      const id = 8100 + i;
      makeStub(id, "movie", `Stub ${id}`);
      return candidateFor(id, "movie", `Stub ${id}`);
    });

    vi.mocked(global.fetch).mockImplementation(async (url) => tmdbDetailsResponse(tmdbIdFromUrl(url)));

    await lazilyEnrichStubCandidates(candidates);

    expect(global.fetch).toHaveBeenCalledTimes(MAX_LAZY_ENRICH_PER_REQUEST);

    const rows = testDb.select().from(schema.titles).all();
    const enrichedCount = rows.filter((r) => r.genres != null).length;
    expect(enrichedCount).toBe(MAX_LAZY_ENRICH_PER_REQUEST);
  });

  it("returns the input unchanged when there are no stubs to enrich", async () => {
    const { lazilyEnrichStubCandidates } = await import("./lazyEnrich");
    const candidates: ReturnType<typeof candidateFor>[] = [];
    const result = await lazilyEnrichStubCandidates(candidates);
    expect(result).toBe(candidates); // same reference — early-return path
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
