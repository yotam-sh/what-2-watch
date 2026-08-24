// ---------------------------------------------------------------------------
// Recommendation orchestration — the DB-facing layer src/app/api/recommend
// calls. Ties together score.ts (content-based, the path that must always
// work — constraint 23), cf.ts (gated), and ltr.ts (gated) into one ranked
// list per mode. Reuses reconcile.ts for watch history rather than
// re-querying watch_events/titles directly, per the phase brief; Plex
// viewCount/viewOffset/leafCount live only in plex_items (outside
// reconcile.ts's scope), so those are read directly here.
//
// COLD START: a brand-new user has an empty watchHistory, so computeCentroid
// returns null, contentScore() returns 0 for every candidate, and cf/ltr
// both come back null (no persisted rows for this user). The candidate pool
// itself is still built and filtered normally, so recommend() still returns
// real, non-empty, filtered results — jittered by the seed for variety —
// instead of an empty list or an error. That's the whole point of the
// score=0 default rather than a special-cased "if no history, throw/return
// []" branch.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { interactions, plexItems, titles, watchlistItems } from "@/db/schema";
import { isInProgress } from "@/lib/plex/library";
import { getReconciledWatchHistory } from "@/lib/reconcile";
import { getCfScoresForUser } from "./cf";
import { decodeVector, parseJsonStringArray } from "./embed";
import { titleKey, type MediaType, type TitleIdentity } from "./key";
import { buildFeatureVector, loadLtrModel, predict as predictLtr } from "./ltr";
import {
  applyHardFilters,
  applyRecencyDecay,
  applySeededJitter,
  buildGenreAffinity,
  computeCentroid,
  computeMedianRuntime,
  contentScore,
  deriveSeed,
  genreAffinityScore,
  rankBinge,
  type BingeCandidate,
  type FilterableCandidate,
  type ScoreFilters,
  type ScoredKey,
  type WatchSignal,
} from "./score";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 12;

/** How much a trained CF score can move the final ranking, relative to
 *  content score's roughly [-1, 1] range. CF scores are unbounded ALS dot
 *  products, so this is a soft cap via a small multiplier rather than a
 *  normalization pass — good enough at this data scale, and CF only ever
 *  contributes when it's actually trained (see cf.ts gating). */
const CF_BLEND_WEIGHT = 0.4;
/** How much a trained per-user LTR model's verdict can move the final score,
 *  as a fraction of the blend — the rest keeps deferring to
 *  content(+CF)score. LTR already incorporates cosine score as one of its
 *  own features, so this is deliberately a blend, not a full replacement:
 *  a still-early per-user model shouldn't be trusted to override content
 *  similarity entirely. */
const LTR_BLEND_WEIGHT = 0.6;

export type RecommendMode = "rewatch" | "watchlist" | "discover" | "continue" | "binge";

export interface RecommendOptions {
  mode: RecommendMode;
  filters?: ScoreFilters;
  /** Explicit seed for a reproducible "roll again". Omit to get the default
   *  per-user-per-day seed (see score.ts's deriveSeed). */
  seed?: number;
  limit?: number;
}

export interface RecommendedCandidate extends TitleIdentity {
  title: string;
  year: number | null;
  runtime: number | null;
  posterPath: string | null;
  score: number;
  why: string[];
}

type TitleRow = typeof titles.$inferSelect;

function loadAllTitles(): TitleRow[] {
  return db.select().from(titles).all();
}

interface PlexItemAgg {
  viewCount: number;
  viewOffset: number | null;
  leafCount: number | null;
  viewedLeafCount: number | null;
}

/** A title can in principle back more than one plex_items row for the same
 *  user (duplicate copies across libraries/servers) — aggregate defensively
 *  rather than assuming 1:1. */
function aggregatePlexItemsByTitle(rows: (typeof plexItems.$inferSelect)[]): Map<string, PlexItemAgg> {
  const map = new Map<string, PlexItemAgg>();
  for (const row of rows) {
    if (row.tmdbId === null || row.mediaType === null) continue;
    const key = titleKey({ tmdbId: row.tmdbId, mediaType: row.mediaType as MediaType });
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        viewCount: row.viewCount ?? 0,
        viewOffset: row.viewOffset ?? null,
        leafCount: row.leafCount ?? null,
        viewedLeafCount: row.viewedLeafCount ?? null,
      });
    } else {
      existing.viewCount = Math.max(existing.viewCount, row.viewCount ?? 0);
      if (row.viewOffset && row.viewOffset > 0) existing.viewOffset = row.viewOffset;
      if (row.leafCount !== null) existing.leafCount = row.leafCount;
      if (row.viewedLeafCount !== null) existing.viewedLeafCount = row.viewedLeafCount;
    }
  }
  return map;
}

function loadLastShownAtByKey(userId: string): Map<string, number> {
  const rows = db
    .select({ tmdbId: interactions.tmdbId, mediaType: interactions.mediaType, createdAt: interactions.createdAt })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.action, "shown")))
    .all();
  const map = new Map<string, number>();
  for (const r of rows) {
    const key = titleKey({ tmdbId: r.tmdbId, mediaType: r.mediaType as MediaType });
    const t = r.createdAt.getTime();
    const existing = map.get(key);
    if (existing === undefined || t > existing) map.set(key, t);
  }
  return map;
}

interface TasteContext {
  centroid: Float32Array | null;
  genreAffinity: Map<string, number>;
  userMedianRuntime: number | null;
  lastWatchedAtByKey: Map<string, number>;
  letterboxdRatingByKey: Map<string, number>;
}

function buildTasteContext(
  userId: string,
  allTitles: TitleRow[],
  plexAgg: Map<string, PlexItemAgg>,
): TasteContext {
  const watchHistory = getReconciledWatchHistory(userId);
  const titlesByKey = new Map(allTitles.map((t) => [titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }), t]));

  const embeddingsByKey = new Map<string, Float32Array>();
  const genresByKey = new Map<string, string[]>();
  for (const t of allTitles) {
    const key = titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType });
    if (t.embedding) embeddingsByKey.set(key, decodeVector(t.embedding));
    genresByKey.set(key, parseJsonStringArray(t.genres));
  }

  const signals: WatchSignal[] = watchHistory.map((w) => ({
    tmdbId: w.tmdbId,
    mediaType: w.mediaType,
    letterboxdRating: w.letterboxdRating,
    viewCount: plexAgg.get(titleKey(w))?.viewCount ?? 0,
  }));

  const centroid = computeCentroid(signals, embeddingsByKey);
  const genreAffinity = buildGenreAffinity(signals, genresByKey);
  const userMedianRuntime = computeMedianRuntime(watchHistory.map((w) => titlesByKey.get(titleKey(w))?.runtime ?? null));

  const lastWatchedAtByKey = new Map<string, number>();
  const letterboxdRatingByKey = new Map<string, number>();
  for (const w of watchHistory) {
    lastWatchedAtByKey.set(titleKey(w), w.lastWatchedAt.getTime());
    if (w.letterboxdRating !== null) letterboxdRatingByKey.set(titleKey(w), w.letterboxdRating);
  }

  return { centroid, genreAffinity, userMedianRuntime, lastWatchedAtByKey, letterboxdRatingByKey };
}

interface ScoredCandidate extends FilterableCandidate, ScoredKey {
  title: string;
  posterPath: string | null;
  why: string[];
}

/** DISCOVER MODE (Phase 6 "discover pool"): the primary candidate pool is
 *  the user's own Plex library — items synced with view_count = 0, i.e.
 *  "you already own this, you just haven't watched it" — via plexAgg, which
 *  is already keyed by (tmdbId, mediaType) and already carries the per-title
 *  max viewCount across every plex_items row for this user (see
 *  aggregatePlexItemsByTitle above). A title is still excluded if the
 *  *reconciled* watch history (watch_events, both Plex and Letterboxd) says
 *  it was actually watched — a Plex view_count of 0 doesn't rule out having
 *  watched it on Letterboxd, or having watched a duplicate copy that rolled
 *  up into a different plex_items row.
 *
 *  COLD START (constraint 23) / not-yet-synced fallback: before Phase 6, a
 *  full-library sync never ran, so no plex_items row is unwatched-and-linked
 *  for anyone — this pool would always be empty. If it comes back empty
 *  (brand-new user, or a user whose Plex library sync hasn't been run since
 *  linking, or one whose whole library happens to be already watched),
 *  fall back to the pre-Phase-6 behavior: the whole `titles` catalog minus
 *  watched, so discover still returns *something* rather than nothing. */
function buildDiscoverPool(
  allTitles: TitleRow[],
  plexAgg: Map<string, PlexItemAgg>,
  watchedKeys: Set<string>,
): TitleRow[] {
  const libraryPool = allTitles.filter((t) => {
    const key = titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType });
    const agg = plexAgg.get(key);
    return agg !== undefined && agg.viewCount === 0 && !watchedKeys.has(key);
  });
  if (libraryPool.length > 0) return libraryPool;
  return allTitles.filter(
    (t) => !watchedKeys.has(titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType })),
  );
}

function buildCandidatePool(
  mode: Exclude<RecommendMode, "binge">,
  userId: string,
  allTitles: TitleRow[],
  plexAgg: Map<string, PlexItemAgg>,
  watchedKeys: Set<string>,
): TitleRow[] {
  if (mode === "discover") {
    return buildDiscoverPool(allTitles, plexAgg, watchedKeys);
  }
  if (mode === "rewatch") {
    // "must have view_count >= 1" per the plan — Plex-specific signal, not
    // just "appears in reconciled watch history" (which would also admit
    // Letterboxd-only watches Plex never confirmed).
    return allTitles.filter(
      (t) => (plexAgg.get(titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }))?.viewCount ?? 0) >= 1,
    );
  }
  if (mode === "continue") {
    return allTitles.filter((t) => {
      const agg = plexAgg.get(titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }));
      if (!agg) return false;
      return isInProgress({ viewCount: agg.viewCount, viewOffset: agg.viewOffset ?? undefined });
    });
  }
  // watchlist
  const watchlistRows = db.select().from(watchlistItems).where(eq(watchlistItems.userId, userId)).all();
  const watchlistKeys = new Set(
    watchlistRows.map((r) => titleKey({ tmdbId: r.tmdbId, mediaType: r.mediaType as MediaType })),
  );
  return allTitles.filter((t) => watchlistKeys.has(titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType })));
}

function modeWhy(mode: Exclude<RecommendMode, "binge">): string | null {
  switch (mode) {
    case "watchlist":
      return "On your watchlist";
    case "continue":
      return "Pick up where you left off";
    case "rewatch":
      return "You've watched this before";
    default:
      return null;
  }
}

export function recommend(userId: string, options: RecommendOptions): RecommendedCandidate[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const filters = options.filters ?? {};
  const seed = deriveSeed(userId, options.seed);
  const now = Date.now();

  const allTitles = loadAllTitles();
  const userPlexItems = db.select().from(plexItems).where(eq(plexItems.userId, userId)).all();
  const plexAgg = aggregatePlexItemsByTitle(userPlexItems);

  if (options.mode === "binge") {
    return recommendBinge(allTitles, plexAgg, filters, seed, limit);
  }

  const watchHistory = getReconciledWatchHistory(userId);
  const watchedKeys = new Set(watchHistory.map(titleKey));
  const pool = buildCandidatePool(options.mode, userId, allTitles, plexAgg, watchedKeys);
  if (pool.length === 0) return [];

  const taste = buildTasteContext(userId, allTitles, plexAgg);
  const cfScores = getCfScoresForUser(
    userId,
    pool.map((t) => ({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType })),
  );
  const ltrModel = loadLtrModel(userId);
  const lastShownAtByKey = loadLastShownAtByKey(userId);
  const genresByKey = new Map(
    allTitles.map((t) => [titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }), parseJsonStringArray(t.genres)]),
  );
  const embeddingsByKey = new Map<string, Float32Array>();
  for (const t of allTitles) {
    if (t.embedding) embeddingsByKey.set(titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }), decodeVector(t.embedding));
  }

  const staticModeWhy = modeWhy(options.mode);

  const scored: ScoredCandidate[] = pool.map((t) => {
    const identity: TitleIdentity = { tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType };
    const key = titleKey(identity);
    const genres = genresByKey.get(key) ?? [];
    const embedding = embeddingsByKey.get(key) ?? null;
    const cosine = contentScore(embedding, taste.centroid);

    const why: string[] = [];
    if (staticModeWhy) why.push(staticModeWhy);
    if (taste.centroid && cosine > 0.3) why.push("Matches your taste");

    let score = cosine;

    const cfScore = cfScores?.get(key);
    if (cfScore !== undefined) {
      score += cfScore * CF_BLEND_WEIGHT;
      why.push("Liked by users with similar taste");
    }

    if (ltrModel) {
      const lastWatched = taste.lastWatchedAtByKey.get(key);
      const daysSinceLastWatch = lastWatched !== undefined ? (now - lastWatched) / MS_PER_DAY : null;
      const affinity = genreAffinityScore(genres, taste.genreAffinity);
      const features = buildFeatureVector({
        cosineScore: cosine,
        daysSinceLastWatch,
        candidateRuntime: t.runtime,
        userMedianRuntime: taste.userMedianRuntime,
        genreAffinity: affinity,
        sourceRating: taste.letterboxdRatingByKey.get(key) ?? null,
      });
      const prob = predictLtr(features, ltrModel);
      score = score * (1 - LTR_BLEND_WEIGHT) + (prob - 0.5) * 2 * LTR_BLEND_WEIGHT;
      why.push("Personalized ranking");
    }

    return {
      tmdbId: t.tmdbId,
      mediaType: identity.mediaType,
      title: t.title,
      year: t.year,
      runtime: t.runtime,
      genres,
      posterPath: t.posterPath,
      key,
      score,
      why,
    };
  });

  const filtered = applyHardFilters(scored, filters, { lastWatchedAtByKey: taste.lastWatchedAtByKey, now });
  const decayed = applyRecencyDecay(filtered, {
    lastWatchedAtByKey: taste.lastWatchedAtByKey,
    lastShownAtByKey,
    now,
  });
  const jittered = applySeededJitter(decayed, seed);

  return jittered.slice(0, limit).map((c) => ({
    tmdbId: c.tmdbId,
    mediaType: c.mediaType,
    title: c.title,
    year: c.year,
    runtime: c.runtime,
    posterPath: c.posterPath,
    score: c.score,
    why: c.why,
  }));
}

function recommendBinge(
  allTitles: TitleRow[],
  plexAgg: Map<string, PlexItemAgg>,
  filters: ScoreFilters,
  seed: number,
  limit: number,
): RecommendedCandidate[] {
  const tvTitles = allTitles.filter((t) => t.mediaType === "tv");
  const filterable: FilterableCandidate[] = tvTitles.map((t) => ({
    tmdbId: t.tmdbId,
    mediaType: "tv",
    runtime: t.runtime,
    year: t.year,
    genres: parseJsonStringArray(t.genres),
  }));
  const filteredKeys = new Set(applyHardFilters(filterable, filters).map(titleKey));

  const candidates: BingeCandidate[] = tvTitles
    .filter((t) => filteredKeys.has(titleKey({ tmdbId: t.tmdbId, mediaType: "tv" })))
    .map((t) => {
      const agg = plexAgg.get(titleKey({ tmdbId: t.tmdbId, mediaType: "tv" }));
      return {
        tmdbId: t.tmdbId,
        mediaType: "tv" as const,
        runtime: t.runtime,
        leafCount: agg?.leafCount ?? null,
        viewedLeafCount: agg?.viewedLeafCount ?? null,
      };
    });

  const ranked = rankBinge(candidates);
  const jittered = applySeededJitter(
    ranked.map((r) => ({ ...r, key: titleKey(r) })),
    seed,
  );

  const titlesByKey = new Map(tvTitles.map((t) => [titleKey({ tmdbId: t.tmdbId, mediaType: "tv" }), t]));

  return jittered.slice(0, limit).map((r) => {
    const row = titlesByKey.get(r.key);
    const hours = Math.round((r.remainingRuntimeMinutes / 60) * 10) / 10;
    return {
      tmdbId: r.tmdbId,
      mediaType: "tv" as const,
      title: row?.title ?? `Unknown (${r.tmdbId})`,
      year: row?.year ?? null,
      runtime: row?.runtime ?? null,
      posterPath: row?.posterPath ?? null,
      score: r.score,
      why: [`${r.remainingEpisodes} episode${r.remainingEpisodes === 1 ? "" : "s"} left (~${hours}h)`],
    };
  });
}
