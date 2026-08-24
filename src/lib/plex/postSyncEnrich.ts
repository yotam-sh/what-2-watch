// ---------------------------------------------------------------------------
// Automatic, best-effort enrichment triggered after a successful Plex sync
// (see src/app/api/plex/sync/route.ts). Bridges tmdb/backfill.ts (TMDB
// metadata) and ml/embedBackfill.ts (embeddings) — both already resumable,
// priority-ordered, rate-limited batch jobs designed to be invoked
// externally (`npm run tmdb:backfill` / `ml:backfill`, see those files'
// runBackfill.ts CLI wrappers). This module just invokes them, bounded, in
// the background, from inside the already-running server process — it does
// not reimplement any of their selection/resumability/rate-limit logic.
//
// WHY THIS EXISTS: a Plex sync inserts bare stub rows (see
// src/lib/plex/titlesStub.ts) for everything in a linked library/watchlist.
// Those stubs have no genres/runtime/poster/embedding until something
// enriches them. Previously only a manually-triggered CLI backfill did
// that — a step a new signup has no reason to know exists, and one that a
// growing library would need forever. Firing a bounded pass automatically
// after every sync means the app self-heals without an operator remembering
// to run anything, while lazyEnrich.ts (src/lib/tmdb/lazyEnrich.ts) still
// covers the handful of candidates a single /api/recommend request actually
// surfaces in the meantime.
//
// NOT ON THE REQUEST PATH: the sync route calls triggerPostSyncEnrichment()
// and deliberately does not await it before responding — see the route for
// the `void` call. Every failure in here is caught and logged, never
// rethrown: a TMDB outage or an exhausted rate limit must never turn an
// already-successful sync into a failed HTTP response, and by the time this
// settles the route has long since sent its response. (This still honors
// backfill.ts's own file header, "must never run inside the synchronous
// Plex sync route" — this runs AFTER the route resolves, detached from the
// response, not inside it.)
//
// BOUNDED: AUTO_ENRICH_TMDB_LIMIT / AUTO_ENRICH_EMBED_LIMIT cap how many
// titles a single post-sync pass processes, regardless of library size — a
// ~1,900-item library catches up over several syncs, one bounded pass per
// sync, rather than one pass trying to walk the whole thing. Both
// backfillTmdbEnrichment and backfillEmbeddings are resumable by
// construction (each call re-queries "still unenriched"), so the next
// sync's pass picks up exactly where this one stopped — no offset/cursor
// bookkeeping needed here either. An uncapped pass would mean a sync
// response that returned in milliseconds silently leaves a
// multi-thousand-request TMDB crawl running in the background indefinitely,
// which is exactly the "surprise-run" outcome backfill.ts's header warns
// against — bounding it keeps each pass's resource use predictable.
//
// EMBEDDINGS CHAINED AFTER TMDB, NOT IN PARALLEL: TMDB enrichment is
// network-bound; embedding (embed.ts) is local and CPU-bound, running on
// the same NAS that may simultaneously be serving Plex transcodes and app
// requests (recommend.ts does brute-force cosine similarity on every
// request). Running them sequentially — embeddings only after the TMDB
// pass finishes — means this job's CPU-heavy half never overlaps with its
// network-heavy half, and caps its own footprint independently (a tighter
// limit than the TMDB pass) rather than adding a second uncoordinated
// background load. Skipping embeddings entirely was considered and
// rejected: without them a freshly-TMDB-enriched title still can't be
// cosine-ranked, so recommendations would keep looking broken even after
// this pass "succeeded."
//
// CONCURRENCY GUARD: a module-level in-process lock (`running`, below).
// This server runs as a single Next.js process (no clustering), so this
// correctly serializes every source of a post-sync trigger *within this
// process* — two syncs completing close together, or a retried sync,
// collapse into "only one pass runs; the other is skipped, nothing queues."
// It does NOT reach across processes: it can't stop a concurrently-run
// `docker compose exec ... tmdb:backfill` CLI invocation (a separate `node`
// process) from also hitting TMDB. That cross-process overlap is left
// unguarded deliberately rather than building coordination (e.g. a DB
// advisory-lock row) nothing else here needs — both
// backfillTmdbEnrichment's batch selection and tmdbGet's own
// 429/Retry-After handling (tmdb/client.ts) are safe under it: worst case
// is a handful of duplicate in-flight requests for the same still-
// unenriched title, resolved by whichever onConflictDoUpdate lands last.
// It degrades to "a bit more TMDB traffic for a moment," never to
// corrupted data — see the module docs on backfill.ts for the invariants
// that make that true.
//
// DIES ON CONTAINER RESTART, AND THAT'S FINE: this is a plain in-memory
// async job with no persistence — a restart mid-pass just drops it.
// Nothing is lost: the next sync (or a manual CLI run) resumes from
// "still unenriched," identically to a Ctrl-C'd CLI backfill. No job
// table, no retry queue, on purpose — this entirely depends on
// backfill.ts/embedBackfill.ts's own resumability rather than
// reimplementing it.
// ---------------------------------------------------------------------------

import { backfillEmbeddings } from "@/lib/ml/embedBackfill";
import { backfillTmdbEnrichment } from "@/lib/tmdb/backfill";

/** TMDB-enriched titles per post-sync pass. Deliberately much smaller than a
 *  manual `tmdb:backfill` run's default (unbounded) — this fires after
 *  every sync, so a large initial library catches up over a handful of
 *  syncs instead of one pass trying to walk the whole thing inline. */
export const AUTO_ENRICH_TMDB_LIMIT = 200;

/** Titles embedded per post-sync pass, after the TMDB step above completes.
 *  Capped lower than the TMDB limit because embedding is CPU-bound and runs
 *  on the same host serving live requests — see file header. */
export const AUTO_ENRICH_EMBED_LIMIT = 100;

/** True while a post-sync pass is in flight in this process — the
 *  concurrency guard described in the file header. */
let running = false;

async function runPass(): Promise<void> {
  const tmdbResult = await backfillTmdbEnrichment({ limit: AUTO_ENRICH_TMDB_LIMIT });
  // eslint-disable-next-line no-console -- background job, not request-path code
  console.log(`[postSyncEnrich] tmdb: ${tmdbResult.done} enriched, ${tmdbResult.skipped} skipped.`);

  const embedResult = await backfillEmbeddings({ maxTitles: AUTO_ENRICH_EMBED_LIMIT });
  // eslint-disable-next-line no-console -- background job, not request-path code
  console.log(`[postSyncEnrich] embeddings: ${embedResult.processed} embedded, ${embedResult.failed} failed.`);
}

/** Kicks off one bounded TMDB-then-embeddings pass in the background and
 *  returns a promise that resolves once it settles (or immediately, if a
 *  pass is already running — see the concurrency guard above). Callers on
 *  the request path (the sync route) must NOT await this — see file header
 *  — but the returned promise lets tests observe completion deterministically
 *  instead of racing a detached job. Never rejects: every failure inside is
 *  caught and logged. */
export function triggerPostSyncEnrichment(): Promise<void> {
  if (running) {
    // eslint-disable-next-line no-console -- background job, not request-path code
    console.log("[postSyncEnrich] a pass is already running in this process — skipping.");
    return Promise.resolve();
  }
  running = true;
  return runPass()
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console -- background job, not request-path code
      console.error("[postSyncEnrich] background enrichment pass failed", err);
    })
    .finally(() => {
      running = false;
    });
}
