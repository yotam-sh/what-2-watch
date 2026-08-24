// ---------------------------------------------------------------------------
// Integration tests for embedBackfill.ts — same throwaway-migrated-SQLite
// approach as librarySync.test.ts (see that file's header): mocks @/db/client
// to point at a real, migrated file so the DB-writing selection/write logic
// is exercised for real, while embed.ts's model is swapped for a fast fake
// via __setExtractorForTest (embed.ts's own test hook — no real ONNX/network
// touched).
//
// The focus here is the fix for the 502-after-5,680ms incident (see
// syncJob.ts's file header for the full story): backfillEmbeddings() must
// yield to the event loop between items rather than running every
// embedding back to back in one synchronous stretch. These tests assert
// that mechanism directly (a setImmediate-based yield fires once per
// embedded item) alongside the pre-existing resumable-batch behavior.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applySqlcipherKey } from "@/db/sqlcipherKey";
import * as schema from "@/db/schema";
import { env } from "@/lib/env";
import { __setExtractorForTest } from "./embed";

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-embedbackfill-test-"));
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

let tmdbIdCounter = 100000;
function insertEnrichedStub(overrides: Partial<typeof schema.titles.$inferInsert> = {}) {
  tmdbIdCounter += 1;
  testDb
    .insert(schema.titles)
    .values({
      tmdbId: tmdbIdCounter,
      mediaType: "movie",
      title: `Title ${tmdbIdCounter}`,
      genres: JSON.stringify(["Action"]),
      overview: "Something happens.",
      embedding: null,
      ...overrides,
    })
    .run();
  return tmdbIdCounter;
}

beforeEach(() => {
  __setExtractorForTest(async () => ({ data: new Float32Array([1, 0, 0]) }));
});

afterEach(() => {
  __setExtractorForTest(null);
  vi.restoreAllMocks();
  testDb.delete(schema.titles).run();
});

describe("backfillEmbeddings", () => {
  it("embeds every unenriched-but-genred title and writes the vector back", async () => {
    const { backfillEmbeddings } = await import("./embedBackfill");
    const id1 = insertEnrichedStub();
    const id2 = insertEnrichedStub();

    const result = await backfillEmbeddings({ delayMs: 0 });

    expect(result).toEqual({ processed: 2, failed: 0 });
    for (const id of [id1, id2]) {
      const row = testDb
        .select()
        .from(schema.titles)
        .where(eq(schema.titles.tmdbId, id))
        .get();
      expect(row?.embedding).not.toBeNull();
    }
  });

  it("skips titles that are still bare stubs (genres IS NULL)", async () => {
    const { backfillEmbeddings } = await import("./embedBackfill");
    insertEnrichedStub({ genres: null });

    const result = await backfillEmbeddings({ delayMs: 0 });

    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it("counts a genuinely-empty enriched title as failed rather than retrying it forever", async () => {
    const { backfillEmbeddings } = await import("./embedBackfill");
    insertEnrichedStub({ genres: "[]", overview: "" });

    const result = await backfillEmbeddings({ delayMs: 0 });

    expect(result).toEqual({ processed: 0, failed: 1 });
  });

  it("respects maxTitles as a cap on how many titles one call processes", async () => {
    const { backfillEmbeddings } = await import("./embedBackfill");
    insertEnrichedStub();
    insertEnrichedStub();
    insertEnrichedStub();

    const result = await backfillEmbeddings({ delayMs: 0, maxTitles: 2 });

    expect(result).toEqual({ processed: 2, failed: 0 });
  });

  it("yields to the event loop (via setImmediate) once per embedded item, not just once per batch", async () => {
    const { backfillEmbeddings } = await import("./embedBackfill");
    insertEnrichedStub();
    insertEnrichedStub();
    insertEnrichedStub();

    const realSetImmediate = global.setImmediate;
    const setImmediateSpy = vi
      .spyOn(global, "setImmediate")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching Node's overloaded setImmediate signature
      .mockImplementation(((cb: () => void) => realSetImmediate(cb)) as any);

    const result = await backfillEmbeddings({ delayMs: 0, batchSize: 16 });

    expect(result.processed).toBe(3);
    // One yield per processed item — a batch of 3 must not run all three
    // embeddings back to back with zero event-loop turns in between.
    expect(setImmediateSpy).toHaveBeenCalledTimes(3);
  });

  it("has fully written each title's embedding to the DB before yielding for the next item", async () => {
    // Asserts ordering, not just count: by the time the Nth yield happens,
    // the Nth item's DB write has already landed — i.e. the yield is
    // interleaved *between* items, not batched up at the end.
    const { backfillEmbeddings } = await import("./embedBackfill");
    const ids = [insertEnrichedStub(), insertEnrichedStub()];

    const writesSeenAtEachYield: number[] = [];
    const realSetImmediate = global.setImmediate;
    vi.spyOn(global, "setImmediate").mockImplementation(((cb: () => void) => {
      const embeddedSoFar = ids.filter((id) => {
        const row = testDb.select().from(schema.titles).where(eq(schema.titles.tmdbId, id)).get();
        return row?.embedding != null;
      }).length;
      writesSeenAtEachYield.push(embeddedSoFar);
      return realSetImmediate(cb);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    await backfillEmbeddings({ delayMs: 0 });

    // After the 1st item's yield, exactly 1 write has landed; after the
    // 2nd's, exactly 2 — never 0 (proving the write happens before the
    // yield) and never both-at-once-then-yield-twice (proving it isn't
    // just yielding once per batch after doing all the work).
    expect(writesSeenAtEachYield).toEqual([1, 2]);
  });
});
