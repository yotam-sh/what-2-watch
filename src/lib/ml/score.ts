// ---------------------------------------------------------------------------
// Content-based scoring — the path that MUST always work (constraint 23:
// cold start is real). Every function here is pure: no DB, no network, no
// model inference. The DB-orchestrating caller lives in recommend.ts, which
// loads real data (via reconcile.ts and direct plexItems/watchlistItems
// reads) and feeds it through these functions — exactly the pure/orchestration
// split librarySync.ts/library.ts and store.ts/mapper.ts already establish
// in this codebase.
//
// A brand-new user has no watch history at all, so computeCentroid()
// legitimately returns null for them. Every caller downstream treats that as
// "score everything as centroid-neutral" (0), never as an error — see
// recommend.ts. That's what makes cold start "sensible non-empty results,"
// not a special-cased empty list.
// ---------------------------------------------------------------------------

import type { MediaType, TitleIdentity } from "./key";
import { titleKey } from "./key";
import { cosineSimilarity, l2Normalize } from "./embed";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY; // calendar-approximate; fine for a "months since" filter

// ---------------------------------------------------------------------------
// Taste centroid
// ---------------------------------------------------------------------------

export interface WatchSignal extends TitleIdentity {
  /** Most recent Letterboxd rating for this title, half-star scale
   *  (0.5..5), or null if never rated on Letterboxd — NOT coerced to 0 (see
   *  reconcile.ts / the Phase 3 "unrated is not a 0-star film" rule, which
   *  this module carries forward into the centroid). */
  letterboxdRating: number | null;
  /** Plex viewCount (0 if never seen on Plex at all). Used as the taste
   *  signal only when there's no Letterboxd rating to prefer instead. */
  viewCount: number;
}

/** "Highly-rated and rewatched" per the plan: a Letterboxd rating clearing
 *  this bar, OR at least this many total Plex views. Half-star granularity
 *  makes 3.5/5 a natural "liked it" cutoff (the midpoint between "it was
 *  fine" and "I loved it"). */
export const MIN_RATING_FOR_CENTROID = 3.5;
export const MIN_VIEWCOUNT_FOR_CENTROID = 2;

/** Caps how much one obsessively-rewatched title can dominate the viewCount
 *  branch of the centroid weight — without this, a title watched 40 times
 *  would swamp everything else the user has ever rated. */
export const VIEWCOUNT_WEIGHT_CAP = 5;

export function selectCentroidSignals(signals: WatchSignal[]): WatchSignal[] {
  return signals.filter(
    (s) =>
      (s.letterboxdRating !== null && s.letterboxdRating >= MIN_RATING_FOR_CENTROID) ||
      s.viewCount >= MIN_VIEWCOUNT_FOR_CENTROID,
  );
}

/** Per-title weight feeding the taste centroid. A Letterboxd rating, when
 *  present, is always preferred over viewCount (reconcile.ts: "Letterboxd
 *  ratings are the strongest explicit taste signal available"). Critically,
 *  a title with NO rating that made the cut via rewatch count still gets a
 *  real positive weight here — never 0 — because an unrated film is not a
 *  0-star film. */
export function centroidWeight(signal: WatchSignal): number {
  if (signal.letterboxdRating !== null) {
    // 0.5..5 stars -> 0.1..1 weight. Floored at 0.1 (not 0) so a rating that
    // just barely cleared MIN_RATING_FOR_CENTROID still counts as real
    // signal, same principle as the unrated case below.
    return Math.max(0.1, signal.letterboxdRating / 5);
  }
  const capped = Math.min(signal.viewCount, VIEWCOUNT_WEIGHT_CAP);
  return capped / VIEWCOUNT_WEIGHT_CAP;
}

/** Weighted-average, L2-normalized taste centroid over the user's
 *  highly-rated/rewatched titles. Returns null when there's no usable
 *  signal at all — no qualifying titles, or none of them have an embedding
 *  yet (e.g. fresh deploy before the backfill has run). Callers MUST treat
 *  null as "no taste signal" and degrade to neutral scoring, not as an
 *  error. */
export function computeCentroid(
  signals: WatchSignal[],
  embeddingsByKey: ReadonlyMap<string, Float32Array>,
): Float32Array | null {
  const selected = selectCentroidSignals(signals);
  let sum: Float32Array | null = null;
  let totalWeight = 0;

  for (const s of selected) {
    const vec = embeddingsByKey.get(titleKey(s));
    if (!vec) continue;
    const w = centroidWeight(s);
    if (!sum) sum = new Float32Array(vec.length);
    for (let i = 0; i < vec.length && i < sum.length; i++) sum[i] += vec[i] * w;
    totalWeight += w;
  }

  if (!sum || totalWeight === 0) return null;
  return l2Normalize(sum);
}

/** Content score for one candidate: cosine similarity to the centroid, or a
 *  neutral 0 when there's no centroid (cold start) or the candidate itself
 *  has no embedding yet. Never throws, never returns NaN. */
export function contentScore(candidateEmbedding: Float32Array | null, centroid: Float32Array | null): number {
  if (!candidateEmbedding || !centroid) return 0;
  return cosineSimilarity(candidateEmbedding, centroid);
}

// ---------------------------------------------------------------------------
// Hard filters
// ---------------------------------------------------------------------------

export interface ScoreFilters {
  maxRuntimeMinutes?: number;
  /** e.g. 1990 covers years 1990..1999 inclusive. */
  decade?: number;
  /** Candidate must have at least one of these genres. */
  includeGenres?: string[];
  /** Candidate must have none of these genres. */
  excludeGenres?: string[];
  /** Rewatch mode: exclude titles watched more recently than this many
   *  months ago. Ignored for titles never watched. */
  minMonthsSinceWatched?: number;
}

export interface FilterableCandidate extends TitleIdentity {
  runtime: number | null;
  year: number | null;
  genres: string[];
}

export interface FilterContext {
  /** epoch ms of the most recent watch, per title key. */
  lastWatchedAtByKey?: ReadonlyMap<string, number>;
  now?: number;
}

export function applyHardFilters<T extends FilterableCandidate>(
  candidates: T[],
  filters: ScoreFilters,
  ctx: FilterContext = {},
): T[] {
  const now = ctx.now ?? Date.now();
  return candidates.filter((c) => {
    if (filters.maxRuntimeMinutes !== undefined) {
      if (c.runtime === null || c.runtime > filters.maxRuntimeMinutes) return false;
    }
    if (filters.decade !== undefined) {
      if (c.year === null || c.year < filters.decade || c.year > filters.decade + 9) return false;
    }
    if (filters.includeGenres && filters.includeGenres.length > 0) {
      if (!c.genres.some((g) => filters.includeGenres!.includes(g))) return false;
    }
    if (filters.excludeGenres && filters.excludeGenres.length > 0) {
      if (c.genres.some((g) => filters.excludeGenres!.includes(g))) return false;
    }
    if (filters.minMonthsSinceWatched !== undefined) {
      const lastWatched = ctx.lastWatchedAtByKey?.get(titleKey(c));
      if (lastWatched !== undefined) {
        const monthsSince = (now - lastWatched) / MS_PER_MONTH;
        if (monthsSince < filters.minMonthsSinceWatched) return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Recency-decay penalty — applies to BOTH last-watched and last-shown, per
// the plan: "penalize titles recently shown (via interactions), not just
// recently watched — otherwise the roll feels broken even though it's
// technically correct."
// ---------------------------------------------------------------------------

/** How fast the "I watched this recently" penalty fades. 30 days: a rewatch
 *  suggestion from a month ago has mostly faded; one from last night is
 *  still heavily suppressed. */
export const WATCH_RECENCY_HALF_LIFE_DAYS = 30;
/** How fast the "I was just shown this and didn't pick it" penalty fades.
 *  Deliberately much shorter than watch recency — the goal here is only
 *  "don't show the same three films every single night," not long-term
 *  memory. */
export const SHOWN_RECENCY_HALF_LIFE_DAYS = 3;

export const WATCH_RECENCY_PENALTY_WEIGHT = 0.3;
export const SHOWN_RECENCY_PENALTY_WEIGHT = 0.5;

function exponentialDecayPenalty(daysSince: number | undefined, halfLifeDays: number, weight: number): number {
  if (daysSince === undefined) return 0;
  const clamped = Math.max(daysSince, 0);
  return weight * Math.pow(0.5, clamped / halfLifeDays);
}

export interface RecencyContext {
  lastWatchedAtByKey?: ReadonlyMap<string, number>;
  lastShownAtByKey?: ReadonlyMap<string, number>;
  now?: number;
}

export interface ScoredKey {
  key: string;
  score: number;
}

/** Subtracts the recency-decay penalty from each candidate's score. Operates
 *  on plain {key, score} pairs so it composes with whatever candidate shape
 *  the caller has — see recommend.ts. */
export function applyRecencyDecay<T extends ScoredKey>(scored: T[], ctx: RecencyContext): T[] {
  const now = ctx.now ?? Date.now();
  return scored.map((c) => {
    const watchedAt = ctx.lastWatchedAtByKey?.get(c.key);
    const shownAt = ctx.lastShownAtByKey?.get(c.key);
    const daysSinceWatch = watchedAt !== undefined ? (now - watchedAt) / MS_PER_DAY : undefined;
    const daysSinceShown = shownAt !== undefined ? (now - shownAt) / MS_PER_DAY : undefined;
    const penalty =
      exponentialDecayPenalty(daysSinceWatch, WATCH_RECENCY_HALF_LIFE_DAYS, WATCH_RECENCY_PENALTY_WEIGHT) +
      exponentialDecayPenalty(daysSinceShown, SHOWN_RECENCY_HALF_LIFE_DAYS, SHOWN_RECENCY_PENALTY_WEIGHT);
    return { ...c, score: c.score - penalty };
  });
}

// ---------------------------------------------------------------------------
// Deterministic-given-a-seed "roll again"
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, deterministic PRNG. Not cryptographic; doesn't
 *  need to be, this is UI variety (and cf.ts/ltr.ts's deterministic
 *  initialization), not security. Exported so cf.ts/ltr.ts share this
 *  implementation rather than each rolling their own. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** How much a "roll" can nudge the ranking. Large enough that near-tied
 *  candidates visibly reshuffle between rolls; small enough that a strong
 *  taste-centroid match essentially never loses to a strong taste mismatch. */
export const ROLL_JITTER_WEIGHT = 0.15;

/** Default seed when the caller doesn't pass one explicitly: stable within a
 *  calendar day for a given user (so backgrounding the app and coming back
 *  shows the same roll), different the next day. Callers that want a true
 *  "roll again" pass an explicit, incrementing seed instead. */
export function deriveSeed(userId: string, explicitSeed?: number): number {
  if (explicitSeed !== undefined) return explicitSeed >>> 0;
  const day = new Date().toISOString().slice(0, 10);
  return fnv1a(`${userId}:${day}`);
}

/** Adds a seeded, deterministic jitter to each score and re-sorts descending.
 *  Same seed + same input set => same output order, always — this is what
 *  makes "roll again" reproducible in tests while feeling random to a user
 *  (who supplies a different seed each time they tap the button). Sorts the
 *  input by key first so jitter assignment doesn't depend on incoming
 *  (DB-query, therefore not guaranteed stable) order. */
export function applySeededJitter<T extends ScoredKey>(scored: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const byKey = [...scored].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const jittered = byKey.map((c) => ({ ...c, score: c.score + (rand() * 2 - 1) * ROLL_JITTER_WEIGHT }));
  return jittered.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Binge mode — TV ranked by remaining runtime + overall scale, not episode
// count. See the file-level note in recommend.ts for why "season count" is
// approximated via total leafCount rather than a real season table (Plex
// sync never captured season boundaries — only show- and episode-level
// rows).
// ---------------------------------------------------------------------------

export interface BingeCandidate extends TitleIdentity {
  mediaType: "tv";
  runtime: number | null; // per-episode minutes
  leafCount: number | null; // total episodes across all seasons
  viewedLeafCount: number | null;
}

export interface BingeScore extends TitleIdentity {
  mediaType: "tv";
  remainingEpisodes: number;
  remainingRuntimeMinutes: number;
  score: number; // higher = better binge candidate
}

const DEFAULT_EPISODE_RUNTIME_MINUTES = 30;

/** Penalty per total-series episode, applied on top of remaining runtime.
 *  This is the "season count, not episode count" proxy: two shows can have
 *  the same few episodes *remaining*, but a 6-episode limited series
 *  (leafCount=6) and a 220-episode procedural with 214 already watched
 *  (leafCount=220) are not the same commitment going forward — the
 *  procedural's habit of never actually ending is real signal even though
 *  its immediate remaining-runtime number looks identical. */
export const BINGE_SCALE_PENALTY_PER_EPISODE = 0.5;

export function scoreBingeCandidate(c: BingeCandidate): BingeScore | null {
  if (c.leafCount === null || c.leafCount <= 0) return null;
  const viewed = c.viewedLeafCount ?? 0;
  const remainingEpisodes = Math.max(c.leafCount - viewed, 0);
  if (remainingEpisodes === 0) return null; // fully watched — not a binge candidate

  const perEpisodeRuntime = c.runtime && c.runtime > 0 ? c.runtime : DEFAULT_EPISODE_RUNTIME_MINUTES;
  const remainingRuntimeMinutes = remainingEpisodes * perEpisodeRuntime;
  const score = -remainingRuntimeMinutes - c.leafCount * BINGE_SCALE_PENALTY_PER_EPISODE;

  return {
    tmdbId: c.tmdbId,
    mediaType: "tv",
    remainingEpisodes,
    remainingRuntimeMinutes,
    score,
  };
}

export function rankBinge(candidates: BingeCandidate[]): BingeScore[] {
  return candidates
    .map(scoreBingeCandidate)
    .filter((s): s is BingeScore => s !== null)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Genre affinity + median runtime — shared taste-signal helpers used both by
// the live scorer (recommend.ts) and by ltr.ts's feature construction, so
// both places measure "does this candidate match what the user likes"
// consistently.
// ---------------------------------------------------------------------------

/** Weighted genre affinity built from the same centroid-eligible signals as
 *  computeCentroid() (highly-rated / rewatched titles), so a candidate's
 *  affinity score reflects the same "taste" the embedding centroid does, not
 *  a separately-tuned notion. Empty/all-zero when there's no signal —
 *  cold-start-safe by construction, same as computeCentroid(). */
export function buildGenreAffinity(
  signals: WatchSignal[],
  genresByKey: ReadonlyMap<string, string[]>,
): Map<string, number> {
  const raw = new Map<string, number>();
  for (const s of selectCentroidSignals(signals)) {
    const genres = genresByKey.get(titleKey(s)) ?? [];
    const w = centroidWeight(s);
    for (const g of genres) raw.set(g, (raw.get(g) ?? 0) + w);
  }
  let max = 0;
  for (const v of raw.values()) max = Math.max(max, v);
  if (max === 0) return new Map();
  const normalized = new Map<string, number>();
  for (const [g, v] of raw) normalized.set(g, v / max);
  return normalized;
}

/** Mean of the per-genre affinity across a candidate's genres, in [0, 1]. 0
 *  when the candidate has no genres or the user has no affinity signal at
 *  all (cold start). */
export function genreAffinityScore(candidateGenres: string[], affinity: ReadonlyMap<string, number>): number {
  if (candidateGenres.length === 0 || affinity.size === 0) return 0;
  let sum = 0;
  for (const g of candidateGenres) sum += affinity.get(g) ?? 0;
  return Math.min(sum / candidateGenres.length, 1);
}

/** Median of a set of runtimes (minutes), ignoring null/zero/negative
 *  entries. Null when there's nothing valid to measure against — callers
 *  must treat that as "no runtime preference signal," not 0 minutes. */
export function computeMedianRuntime(runtimes: Array<number | null | undefined>): number | null {
  const valid = runtimes.filter((r): r is number => typeof r === "number" && r > 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
}

export type { MediaType, TitleIdentity };
