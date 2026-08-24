// ---------------------------------------------------------------------------
// Unit tests for postSyncEnrich.ts's orchestration: bounded limits passed
// through, TMDB-then-embeddings ordering, the in-process concurrency guard,
// and that failures never reject (a sync's success must never be undone by
// a background enrichment failure — see the module's file header). The
// underlying backfill functions have their own integration coverage
// (tmdb/backfill.test.ts, and ml/embedBackfill via recommend.test.ts's
// neighbors) — this file only tests the orchestration layer, so both are
// mocked out.
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backfillTmdbEnrichment = vi.fn();
const backfillEmbeddings = vi.fn();

vi.mock("@/lib/tmdb/backfill", () => ({
  backfillTmdbEnrichment: (...args: unknown[]) => backfillTmdbEnrichment(...args),
}));
vi.mock("@/lib/ml/embedBackfill", () => ({
  backfillEmbeddings: (...args: unknown[]) => backfillEmbeddings(...args),
}));

beforeEach(() => {
  vi.resetModules();
  backfillTmdbEnrichment.mockReset();
  backfillEmbeddings.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triggerPostSyncEnrichment", () => {
  it("runs a bounded TMDB pass, then a bounded embeddings pass, in that order", async () => {
    const order: string[] = [];
    backfillTmdbEnrichment.mockImplementation(async () => {
      order.push("tmdb");
      return { done: 3, skipped: 0 };
    });
    backfillEmbeddings.mockImplementation(async () => {
      order.push("embed");
      return { processed: 2, failed: 0 };
    });

    const { triggerPostSyncEnrichment, AUTO_ENRICH_TMDB_LIMIT, AUTO_ENRICH_EMBED_LIMIT } = await import(
      "./postSyncEnrich"
    );

    await triggerPostSyncEnrichment();

    expect(order).toEqual(["tmdb", "embed"]);
    expect(backfillTmdbEnrichment).toHaveBeenCalledWith({ limit: AUTO_ENRICH_TMDB_LIMIT });
    expect(backfillEmbeddings).toHaveBeenCalledWith({ maxTitles: AUTO_ENRICH_EMBED_LIMIT });
  });

  it("skips a second call while a pass is already running in this process", async () => {
    let resolveTmdb!: (v: { done: number; skipped: number }) => void;
    backfillTmdbEnrichment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTmdb = resolve;
        }),
    );
    backfillEmbeddings.mockResolvedValue({ processed: 0, failed: 0 });

    const { triggerPostSyncEnrichment } = await import("./postSyncEnrich");

    const first = triggerPostSyncEnrichment();
    const second = triggerPostSyncEnrichment(); // fires while `first` is still in flight

    expect(backfillTmdbEnrichment).toHaveBeenCalledTimes(1); // second call was a no-op, not a second run
    resolveTmdb({ done: 0, skipped: 0 });
    await Promise.all([first, second]);
  });

  it("allows a new pass once the previous one has settled", async () => {
    backfillTmdbEnrichment.mockResolvedValue({ done: 0, skipped: 0 });
    backfillEmbeddings.mockResolvedValue({ processed: 0, failed: 0 });

    const { triggerPostSyncEnrichment } = await import("./postSyncEnrich");

    await triggerPostSyncEnrichment();
    await triggerPostSyncEnrichment();

    expect(backfillTmdbEnrichment).toHaveBeenCalledTimes(2);
  });

  it("never rejects when the TMDB pass throws, and releases the lock for the next call", async () => {
    backfillTmdbEnrichment.mockRejectedValueOnce(new Error("TMDB is down"));
    backfillEmbeddings.mockResolvedValue({ processed: 0, failed: 0 });

    const { triggerPostSyncEnrichment } = await import("./postSyncEnrich");

    await expect(triggerPostSyncEnrichment()).resolves.toBeUndefined();
    expect(backfillEmbeddings).not.toHaveBeenCalled(); // TMDB step failed before embeddings ran

    // Lock was released in `finally`, so a later call still proceeds.
    backfillTmdbEnrichment.mockResolvedValueOnce({ done: 1, skipped: 0 });
    await triggerPostSyncEnrichment();
    expect(backfillTmdbEnrichment).toHaveBeenCalledTimes(2);
  });

  it("never rejects when the embeddings pass throws", async () => {
    backfillTmdbEnrichment.mockResolvedValue({ done: 1, skipped: 0 });
    backfillEmbeddings.mockRejectedValueOnce(new Error("model failed to load"));

    const { triggerPostSyncEnrichment } = await import("./postSyncEnrich");

    await expect(triggerPostSyncEnrichment()).resolves.toBeUndefined();
  });
});
