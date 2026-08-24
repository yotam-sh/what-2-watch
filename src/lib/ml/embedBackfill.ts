// ---------------------------------------------------------------------------
// DB-writing batch backfill for `titles.embedding` — split from embed.ts for
// the same reason store.ts/librarySync.ts are split from their pure
// counterparts (see those files' headers): this needs a real DB connection
// and the loaded model, so it isn't unit-tested directly. embed.ts's pure
// pieces (buildEmbeddingText, encode/decode, cosine) are, and this file's
// per-row logic is exercised with embed.ts's model mocked out.
//
// RESUMABLE: every run re-queries "embedding IS NULL AND genres IS NOT NULL"
// (only enriched titles — mirrors tmdb/store.ts's isEnriched() convention;
// a bare stub row from Phase 2/3 has genres NULL and is correctly skipped
// until TMDB enrichment fills it in). A crash or a deliberate stop mid-run
// loses nothing: rows this run already embedded no longer match the WHERE
// clause, so the next invocation just continues with whatever's left. No
// offset/cursor bookkeeping needed, and it tolerates new titles being
// enriched concurrently by Phase 3's sync.
//
// RATE-LIMITED: a fixed delay between batches (default 500ms) keeps this
// from pegging the CPU on a home NAS that may simultaneously be serving Plex
// transcodes. This is an explicit, on-demand job (see runBackfill.ts) —
// never triggered inline in a request path.
// ---------------------------------------------------------------------------

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { titles } from "@/db/schema";
import { buildEmbeddingText, embedText, encodeVector, parseJsonStringArray } from "./embed";

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BackfillOptions {
  /** Titles fetched and embedded per batch, with a `delayMs` pause between
   *  batches. */
  batchSize?: number;
  /** Pause between batches, in ms — the rate limit. */
  delayMs?: number;
  /** Safety cap on how many titles a single call will process before
   *  returning, regardless of how many remain. Undefined = no cap (run to
   *  completion). */
  maxTitles?: number;
  onProgress?: (processed: number, failed: number) => void;
}

export interface BackfillResult {
  processed: number;
  failed: number;
}

/** Finds titles missing an embedding, embeds them, and writes the result
 *  back. See file header for the resumability/rate-limiting design. */
export async function backfillEmbeddings(options: BackfillOptions = {}): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  let processed = 0;
  let failed = 0;

  for (;;) {
    if (options.maxTitles !== undefined && processed + failed >= options.maxTitles) break;
    const take =
      options.maxTitles !== undefined ? Math.min(batchSize, options.maxTitles - processed - failed) : batchSize;
    if (take <= 0) break;

    const rows = db
      .select()
      .from(titles)
      .where(and(isNull(titles.embedding), isNotNull(titles.genres)))
      .limit(take)
      .all();
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const text = buildEmbeddingText({
          genres: parseJsonStringArray(row.genres),
          directors: parseJsonStringArray(row.directors),
          cast: parseJsonStringArray(row.cast),
          keywords: parseJsonStringArray(row.keywords),
          overview: row.overview,
        });
        if (text === "") {
          // Enriched but genuinely empty (e.g. genres:"[]", no cast, no
          // overview) — nothing to embed. Counted as failed so it's visible
          // in the report rather than silently retried forever; a future
          // re-enrichment (force=true) is the real fix.
          failed += 1;
          continue;
        }
        const vector = await embedText(text);
        db.update(titles)
          .set({ embedding: encodeVector(vector), updatedAt: new Date() })
          .where(and(eq(titles.tmdbId, row.tmdbId), eq(titles.mediaType, row.mediaType)))
          .run();
        processed += 1;
      } catch (err) {
        failed += 1;
        // eslint-disable-next-line no-console -- this is a CLI batch job, not request-path code
        console.error(`[ml/embedBackfill] failed to embed ${row.mediaType}:${row.tmdbId}`, err);
      }
    }

    options.onProgress?.(processed, failed);
    if (rows.length < take) break; // fewer than requested => nothing left
    await sleep(delayMs);
  }

  return { processed, failed };
}
