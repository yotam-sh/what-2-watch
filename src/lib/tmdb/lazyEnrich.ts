// ---------------------------------------------------------------------------
// Lazy, request-time enrichment for /api/recommend (src/app/api/recommend/
// route.ts). The backfill (backfill.ts / `npm run tmdb:backfill`) is what
// eventually enriches the whole library, but it can take a long time on a
// real Plex library (see the module's file header) — a user must get a
// usable app *before* that finishes, not just after. When recommend() is
// about to hand back a candidate that's still a bare Plex-sync stub (no
// genres — see tmdb/store.ts's isEnriched convention), this enriches it
// inline, right before the response goes out.
//
// BOUNDED, NEVER BLOCKING: this only ever touches the handful of candidates
// actually being returned (recommend.ts already caps that at `limit`,
// itself capped at 50 by the route), and even then only the first
// MAX_LAZY_ENRICH_PER_REQUEST of those that are stubs — never the whole
// candidate pool, which can be thousands of titles. That pool-vs-surfaced
// distinction is what keeps this from becoming a blocking storm: a
// discover-mode request over an entirely unenriched library still only
// fires a handful of TMDB requests, not one per pool candidate.
//
// NEVER FAILS THE REQUEST: every per-title enrichTitle() call is individually
// caught. A TMDB outage, a bad/missing key, or exhausted 429 retries here
// must degrade to "this batch of candidates keeps showing stub data,"
// never a 500 — the whole point of this module is making the app *more*
// resilient before the backfill finishes, not adding a new way to break it.
// ---------------------------------------------------------------------------

import type { TitleIdentity } from "@/lib/ml/key";
import { titleKey } from "@/lib/ml/key";
import { enrichTitle, getTitleRow, isEnriched } from "./store";

/** "A handful" per the design brief — enough that a fresh, mostly-unenriched
 *  library starts feeling useful within a couple of requests, small enough
 *  that one /api/recommend call can never turn into dozens of synchronous
 *  TMDB round-trips. */
export const MAX_LAZY_ENRICH_PER_REQUEST = 5;

/** Fields recommend.ts's RecommendedCandidate exposes that actually change
 *  once a stub is enriched (genres/overview/etc. exist in `titles` but
 *  aren't part of that response shape). Generic over any candidate type
 *  that carries at least these plus a TitleIdentity, so this doesn't need
 *  to import recommend.ts's type directly (keeping this module usable
 *  without pulling in the whole recommend orchestration layer). */
export interface EnrichableCandidate extends TitleIdentity {
  title: string;
  year: number | null;
  runtime: number | null;
  posterPath: string | null;
}

/** Enriches up to MAX_LAZY_ENRICH_PER_REQUEST still-stub candidates from
 *  `candidates` in place, and returns a new array with their display fields
 *  (title/year/runtime/posterPath) refreshed from the now-enriched `titles`
 *  row wherever enrichment succeeded. Candidates that were already
 *  enriched, or that fail to enrich (network error, rate limit, bad id),
 *  pass through unchanged — this never throws. */
export async function lazilyEnrichStubCandidates<T extends EnrichableCandidate>(
  candidates: T[],
): Promise<T[]> {
  const stubs = candidates
    .filter((c) => !isEnriched(c.tmdbId, c.mediaType))
    .slice(0, MAX_LAZY_ENRICH_PER_REQUEST);
  if (stubs.length === 0) return candidates;

  const enrichedKeys = new Set<string>();
  await Promise.all(
    stubs.map(async (c) => {
      try {
        await enrichTitle(c.tmdbId, c.mediaType);
        enrichedKeys.add(titleKey(c));
      } catch (err) {
        // Best-effort — see file header. The stub stands in until the next
        // backfill run or the next time this title is surfaced.
        // eslint-disable-next-line no-console
        console.error(`[tmdb/lazyEnrich] on-demand enrichment failed for ${c.mediaType}:${c.tmdbId}`, err);
      }
    }),
  );

  if (enrichedKeys.size === 0) return candidates;

  return candidates.map((c) => {
    if (!enrichedKeys.has(titleKey(c))) return c;
    const row = getTitleRow(c.tmdbId, c.mediaType);
    if (!row || row.genres == null) return c; // shouldn't happen, but never trust it blindly
    return { ...c, title: row.title, year: row.year, runtime: row.runtime, posterPath: row.posterPath };
  });
}
