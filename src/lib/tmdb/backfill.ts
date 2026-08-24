// ---------------------------------------------------------------------------
// DB-writing, priority-ordered, resumable batch backfill for TMDB
// enrichment — the tmdb/ sibling of src/lib/ml/embedBackfill.ts, same split
// rationale (needs a real DB connection and the network, so it isn't
// unit-tested with fixtures the way client.ts/mapper.ts are; unlike
// store.ts, though, it *is* exercised directly in backfill.test.ts by
// combining a throwaway migrated SQLite file (librarySync.test.ts's/
// recommend.test.ts's pattern) with a mocked global.fetch (client.test.ts's
// pattern) — the DB-writing logic here (selection order, resumability,
// concurrency) is exactly what needs covering, and that combination covers
// it without a live TMDB key).
//
// PRIORITY ORDER — not arbitrary, and this is the whole point of this
// module existing separately from "just enrich everything in `titles`
// order": a partially-enriched database (this WILL run for a long time on a
// real library, and a user WILL look at recommendations before it
// finishes) must still produce *good* recommendations, not merely *some*.
// Enriching in `titles` insertion order would enrich Plex library filler
// before it enriches the handful of titles that actually define the user's
// taste. So every unenriched title is ranked into one of four tiers before
// each batch is pulled:
//   0. Titles in `watch_events` — these ARE the taste centroid
//      (score.ts's computeCentroid/buildGenreAffinity). Without embeddings
//      and genres for *these* specifically, cosine similarity and genre
//      affinity have nothing to measure against at all: every candidate
//      scores as a cold-start neutral 0, regardless of how enriched the
//      candidate pool is. This tier is enriched first, always.
//   1. Titles in `watchlist_items` — the user already told the app they
//      want these; watchlist mode (recommend.ts) can't rank or filter them
//      at all while they're bare stubs.
//   2. The rest of the Discover pool: `plex_items` with view_count = 0 —
//      the library recommend.ts's buildDiscoverPool draws from. Enriching
//      this tier is what turns "thousands of owned titles the recommender
//      can't score" into a working Discover mode.
//   3. Everything else (a stub that exists for some other reason — e.g. a
//      bookkeeping row with no watch/watchlist/discover linkage). Still
//      enriched eventually, just last.
//
// RESUMABLE, same convention as embedBackfill.ts: every batch re-queries
// "genres IS NULL", ordered by the priority CASE below. A title that this
// run (or a previous one, or a concurrent Letterboxd sync) already enriched
// no longer matches that WHERE clause, so a Ctrl-C'd run picked back up
// later just continues — no offset/cursor bookkeeping, and it can't
// double-enrich a title moot in-flight enrichment already finished.
//
// RATE-LIMITED: `concurrency` bounds how many TMDB requests are in flight
// at once (default 4 — polite to both TMDB and a NAS's network stack);
// `delayMs` pauses between batches. 429s are NOT handled here — client.ts's
// tmdbGet() already retries them honoring `Retry-After`, so re-implementing
// that here would just be a second, competing retry policy. A title only
// counts as "skipped" once tmdbGet has exhausted ITS retries and thrown.
// ---------------------------------------------------------------------------

import { isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { plexItems, titles, watchEvents, watchlistItems } from "@/db/schema";
import { enrichTitle, type MediaType } from "./store";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// See file header for what each tier means and why the order is fixed.
const PRIORITY_RANK = sql<number>`
  CASE
    WHEN EXISTS (
      SELECT 1 FROM ${watchEvents}
      WHERE ${watchEvents.tmdbId} = ${titles.tmdbId} AND ${watchEvents.mediaType} = ${titles.mediaType}
    ) THEN 0
    WHEN EXISTS (
      SELECT 1 FROM ${watchlistItems}
      WHERE ${watchlistItems.tmdbId} = ${titles.tmdbId} AND ${watchlistItems.mediaType} = ${titles.mediaType}
    ) THEN 1
    WHEN EXISTS (
      SELECT 1 FROM ${plexItems}
      WHERE ${plexItems.tmdbId} = ${titles.tmdbId} AND ${plexItems.mediaType} = ${titles.mediaType}
        AND ${plexItems.viewCount} = 0
    ) THEN 2
    ELSE 3
  END
`;

interface TitleStubRef {
  tmdbId: number;
  mediaType: string;
}

function selectNextBatch(take: number): TitleStubRef[] {
  return db
    .select({ tmdbId: titles.tmdbId, mediaType: titles.mediaType })
    .from(titles)
    .where(isNull(titles.genres))
    .orderBy(PRIORITY_RANK, titles.tmdbId, titles.mediaType)
    .limit(take)
    .all();
}

function countRemaining(): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(titles)
    .where(isNull(titles.genres))
    .get();
  return row?.count ?? 0;
}

/** Runs `worker` over `items` with at most `concurrency` calls in flight at
 *  once. Items are dispatched in array order — for a small item count (as
 *  in tests) this makes the underlying TMDB fetch calls fire in the same
 *  order `items` is in, which is what makes priority order observable. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function runOne(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()));
}

export interface TmdbBackfillProgress {
  /** Successfully enriched so far, this run. */
  done: number;
  /** Failed permanently (e.g. TMDB 404, or repeated 429s that exhausted
   *  tmdbGet's own retries) so far, this run — logged and moved past rather
   *  than blocking the rest of the batch. */
  skipped: number;
  /** Titles still unenriched in the DB, including this run's `skipped` ones
   *  (a `force`-free re-run won't retry them, so they'd otherwise look like
   *  they vanished from the count). */
  remaining: number;
}

export interface TmdbBackfillOptions {
  /** Titles fetched (and priority-ranked) per DB query batch. */
  batchSize?: number;
  /** Max TMDB requests in flight at once. */
  concurrency?: number;
  /** Pause between batches, in ms. */
  delayMs?: number;
  /** --limit: caps how many titles (done + skipped) this single call will
   *  process before returning, regardless of how many remain. Undefined =
   *  run to completion. Lets an operator enrich a slice and see results
   *  without committing to the whole library up front. */
  limit?: number;
  onProgress?: (progress: TmdbBackfillProgress) => void;
}

export interface TmdbBackfillResult {
  done: number;
  skipped: number;
}

/** Finds unenriched titles (see tmdb/store.ts's isEnriched convention —
 *  `genres IS NULL`), enriches them in priority order, and reports progress
 *  as it goes. See file header for the full design rationale. */
export async function backfillTmdbEnrichment(options: TmdbBackfillOptions = {}): Promise<TmdbBackfillResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  let done = 0;
  let skipped = 0;

  for (;;) {
    if (options.limit !== undefined && done + skipped >= options.limit) break;
    const take =
      options.limit !== undefined ? Math.min(batchSize, options.limit - done - skipped) : batchSize;
    if (take <= 0) break;

    const rows = selectNextBatch(take);
    if (rows.length === 0) break;

    await runWithConcurrency(rows, concurrency, async (row) => {
      try {
        await enrichTitle(row.tmdbId, row.mediaType as MediaType);
        done += 1;
      } catch (err) {
        skipped += 1;
        // eslint-disable-next-line no-console -- CLI batch job, not request-path code
        console.error(`[tmdb/backfill] failed to enrich ${row.mediaType}:${row.tmdbId}`, err);
      }
    });

    options.onProgress?.({ done, skipped, remaining: countRemaining() });
    if (rows.length < take) break; // fewer than requested => nothing left
    await sleep(delayMs);
  }

  return { done, skipped };
}
