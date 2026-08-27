// ---------------------------------------------------------------------------
// Learn-to-rank — a per-user logistic ranker trained incrementally via plain
// SGD (constraint 22: hand-rolled TypeScript, same reasoning as cf.ts — no
// ONNX training API, and this is small enough that a hand-rolled trainer is
// entirely reasonable).
//
// Label source: 'skipped'/'snoozed' are label 0 directly — they're explicit
// statements from someone looking straight at the title, true the moment
// they happen. 'picked' is NOT taken at face value: it records the intention
// to watch, not the watching, and someone who bails ten minutes in leaves an
// identical row to someone who loved it. Every pick is therefore resolved
// against Plex's current state (pickOutcome.ts) and only counts as label 1
// once the watch is confirmed. An unconfirmed or abandoned pick is EXCLUDED,
// never flipped to a negative — read that file's header for why a false
// negative is worse than no row at all.
//
// Rows with only action='shown' and no follow-up outcome are likewise
// excluded — they're not a negative, they're "no verdict yet."
//
// FEATURE TIMING: features are reconstructed from the user's CURRENT taste
// signal (current centroid, current genre affinity, current median runtime)
// but recency features (days-since-last-watch) are computed relative to the
// interaction's own `createdAt`, not wall-clock now — training on "what did
// the world look like right before this decision" rather than "what does it
// look like today" avoids leaking future information into past labels. This
// is an approximation (the user's taste centroid may have shifted since),
// accepted deliberately: logging a full feature snapshot at shown-time would
// be the more rigorous alternative but needs no schema change today, and at
// this data scale (a home user's library, not a production ranking system)
// the drift between "features now" and "features when it happened" is
// negligible over the days-to-weeks this trains over.
//
// GATING (constraint 23): meetsLtrTrainingThreshold() gates training the
// same way cf.ts gates ALS. loadLtrModel() gates a second time at serving:
// even a persisted row younger than the threshold (e.g. from a lower
// historical bar, or corrupted) returns null rather than being trusted.
// "No data means no model" is exercised by ltr.test.ts.
// ---------------------------------------------------------------------------

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { interactions, ltrModels, plexItems, titles } from "@/db/schema";
import { getReconciledWatchHistory } from "@/lib/reconcile";
import {
  classifyPickOutcome,
  readBaseline,
  type PickBaselineShape,
  type PickOutcome,
} from "./pickOutcome";
import { decodeVector, parseJsonStringArray } from "./embed";
import type { MediaType } from "./key";
import { titleKey } from "./key";
import {
  buildGenreAffinity,
  computeCentroid,
  computeMedianRuntime,
  contentScore,
  genreAffinityScore,
  mulberry32,
  type WatchSignal,
} from "./score";

// ---------------------------------------------------------------------------
// Feature vector — fixed order, per the plan: cosine score, days since last
// watch, runtime delta from the user's median, genre affinity, source
// rating.
// ---------------------------------------------------------------------------

export const LTR_FEATURE_ORDER = [
  "cosineScore",
  "daysSinceLastWatch",
  "runtimeDelta",
  "genreAffinity",
  "sourceRating",
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Sentinel feature value for "never watched" — deliberately the max of the
 *  scaled range (fully "stale"), letting the model itself learn whether this
 *  user's household prefers novelty or comfort rewatches. */
const NEVER_WATCHED_DAYS_FEATURE = 1;
const DAYS_SCALE = 365;
const RUNTIME_DELTA_SCALE = 120; // minutes; a 2-hour delta saturates the feature

export interface LtrFeatureInput {
  cosineScore: number;
  /** null = candidate has never been watched by this user. */
  daysSinceLastWatch: number | null;
  candidateRuntime: number | null;
  userMedianRuntime: number | null;
  /** Precomputed via score.ts's genreAffinityScore() — in [0, 1]. */
  genreAffinity: number;
  /** This user's own rating for this specific title (Letterboxd
   *  half-star, 0.5..5), or null if never rated. */
  sourceRating: number | null;
}

/** Builds the fixed-order feature vector fed to the logistic model. Every
 *  feature is scaled into a roughly [-1, 1] / [0, 1] range so a single fixed
 *  learning rate works reasonably across all of them without per-feature
 *  standardization infrastructure. */
export function buildFeatureVector(input: LtrFeatureInput): number[] {
  const daysFeature =
    input.daysSinceLastWatch === null
      ? NEVER_WATCHED_DAYS_FEATURE
      : Math.min(Math.max(input.daysSinceLastWatch, 0) / DAYS_SCALE, 1);

  const runtimeDelta =
    input.candidateRuntime !== null && input.userMedianRuntime !== null
      ? Math.min(Math.abs(input.candidateRuntime - input.userMedianRuntime) / RUNTIME_DELTA_SCALE, 1)
      : 0;

  const sourceRating = input.sourceRating !== null ? input.sourceRating / 5 : 0;

  return [input.cosineScore, daysFeature, runtimeDelta, input.genreAffinity, sourceRating];
}

// ---------------------------------------------------------------------------
// Pure logistic regression + SGD — no DB. Unit-tested directly.
// ---------------------------------------------------------------------------

export interface LtrExample {
  features: number[];
  label: 0 | 1;
}

export interface LtrModel {
  weights: number[];
  bias: number;
}

export const LTR_LEARNING_RATE = 0.05;
export const LTR_L2_REGULARIZATION = 0.001;
export const LTR_EPOCHS = 30;

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Predicted probability the user would pick this candidate, in (0, 1). */
export function predict(features: number[], model: LtrModel): number {
  let z = model.bias;
  for (let i = 0; i < features.length && i < model.weights.length; i++) {
    z += features[i] * model.weights[i];
  }
  return sigmoid(z);
}

/** Trains (or continues training, via `options.initial` as a warm start) a
 *  logistic model with plain mini-batch-of-one SGD, L2-regularized.
 *  Deterministic given `options.seed` (controls per-epoch example shuffle
 *  order) — see ltr.test.ts for the determinism/convergence checks. */
export function trainLogisticSgd(examples: LtrExample[], options: {
  initial?: LtrModel;
  learningRate?: number;
  epochs?: number;
  l2?: number;
  seed?: number;
} = {}): LtrModel {
  const dims = LTR_FEATURE_ORDER.length;
  const lr = options.learningRate ?? LTR_LEARNING_RATE;
  const epochs = options.epochs ?? LTR_EPOCHS;
  const l2 = options.l2 ?? LTR_L2_REGULARIZATION;
  const rand = mulberry32(options.seed ?? 7);

  const weights = options.initial ? [...options.initial.weights] : new Array(dims).fill(0);
  let bias = options.initial?.bias ?? 0;

  if (examples.length === 0) return { weights, bias };

  const order = examples.map((_, i) => i);
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const idx of order) {
      const ex = examples[idx];
      const pred = predict(ex.features, { weights, bias });
      const error = ex.label - pred;
      for (let d = 0; d < dims; d++) {
        const x = ex.features[d] ?? 0;
        weights[d] += lr * (error * x - l2 * weights[d]);
      }
      bias += lr * error;
    }
  }

  return { weights, bias };
}

// ---------------------------------------------------------------------------
// Gating — named constants, per the plan.
// ---------------------------------------------------------------------------

/** A logistic model over 5 features needs more than a handful of labeled
 *  examples to not just memorize noise — 30 labeled picks/skips/snoozes is
 *  roughly "a few weeks of actually using the Decide roll," which is also
 *  the point at which a per-user model has a chance to have seen a
 *  reasonable spread of both outcomes. Below it, every request falls back to
 *  content-(+CF-)only scoring. */
export const LTR_MIN_LABELED_INTERACTIONS = 30;

export function meetsLtrTrainingThreshold(numLabeled: number): boolean {
  return numLabeled >= LTR_MIN_LABELED_INTERACTIONS;
}

// ---------------------------------------------------------------------------
// DB orchestration — not unit-tested directly (see cf.ts's file header for
// why; same convention as store.ts/librarySync.ts in this codebase).
// ---------------------------------------------------------------------------

function getTitleRow(tmdbId: number, mediaType: MediaType) {
  return db
    .select()
    .from(titles)
    .where(and(eq(titles.tmdbId, tmdbId), eq(titles.mediaType, mediaType)))
    .get();
}

export interface LtrTrainResult {
  trained: boolean;
  numLabeled: number;
}

/** Retrains one user's LTR model from their full labeled interaction
 *  history, warm-started from the persisted model if one exists. Call this
 *  from an operator-triggered or scheduled job (e.g. after a batch of new
 *  feedback), never from the request path. */
/** DB-reading adapter for pickOutcome.ts's pure rules — the only place a
 *  playback state is fetched. Kept here rather than in pickOutcome.ts so
 *  that module stays free of a db import and its rules stay unit-testable
 *  (same reasoning as library.ts vs librarySync.ts). */
function resolvePickOutcome(
  userId: string,
  tmdbId: number,
  mediaType: MediaType,
  pickedAt: Date,
  baseline: PickBaselineShape | null,
): PickOutcome {
  const row = db
    .select()
    .from(plexItems)
    .where(and(eq(plexItems.userId, userId), eq(plexItems.tmdbId, tmdbId), eq(plexItems.mediaType, mediaType)))
    .get();

  return classifyPickOutcome({
    pickedAt,
    baseline,
    now: new Date(),
    state: row
      ? {
          viewCount: row.viewCount ?? 0,
          viewOffset: row.viewOffset ?? 0,
          duration: row.duration ?? null,
          lastViewedAt: row.lastViewedAt ?? null,
        }
      : null,
  });
}

export function updateLtrModelForUser(userId: string): LtrTrainResult {
  const rows = db
    .select()
    .from(interactions)
    .where(and(eq(interactions.userId, userId), inArray(interactions.action, ["picked", "skipped", "snoozed"])))
    .all();

  if (!meetsLtrTrainingThreshold(rows.length)) {
    return { trained: false, numLabeled: rows.length };
  }

  // Build the same taste signal recommend.ts would use "now" — see file
  // header for why recency features instead anchor on each row's own
  // createdAt.
  const watchHistory = getReconciledWatchHistory(userId);
  const historyKeys = new Set(watchHistory.map(titleKey));
  const genresByKey = new Map<string, string[]>();
  const embeddingsByKey = new Map<string, Float32Array>();
  for (const w of watchHistory) {
    const row = getTitleRow(w.tmdbId, w.mediaType);
    if (!row) continue;
    genresByKey.set(titleKey(w), parseJsonStringArray(row.genres));
    if (row.embedding) embeddingsByKey.set(titleKey(w), decodeVector(row.embedding));
  }

  const signals: WatchSignal[] = watchHistory.map((w) => ({
    tmdbId: w.tmdbId,
    mediaType: w.mediaType,
    letterboxdRating: w.letterboxdRating,
    // reconcile.ts doesn't expose Plex viewCount directly; watchCount (total
    // watch_events across sources) is a reasonable proxy for the "rewatched
    // it" signal this needs.
    viewCount: w.watchCount,
  }));
  const centroid = computeCentroid(signals, embeddingsByKey);
  const genreAffinity = buildGenreAffinity(signals, genresByKey);
  const userMedianRuntime = computeMedianRuntime(
    watchHistory.map((w) => getTitleRow(w.tmdbId, w.mediaType)?.runtime ?? null),
  );

  const examples: LtrExample[] = [];
  for (const row of rows) {
    const mediaType = row.mediaType as MediaType;
    const title = getTitleRow(row.tmdbId, mediaType);
    if (!title) continue; // stub row with no metadata yet — nothing to build features from

    const candidateEmbedding = title.embedding ? decodeVector(title.embedding) : null;
    const cosine = contentScore(candidateEmbedding, centroid);

    const key = titleKey({ tmdbId: row.tmdbId, mediaType });
    const wasWatched = historyKeys.has(key);
    const watchedEntry = watchHistory.find((w) => titleKey(w) === key);
    const daysSinceLastWatch =
      wasWatched && watchedEntry
        ? Math.max((row.createdAt.getTime() - watchedEntry.lastWatchedAt.getTime()) / MS_PER_DAY, 0)
        : null;

    const affinity = genreAffinityScore(parseJsonStringArray(title.genres), genreAffinity);
    const sourceRating = watchedEntry?.letterboxdRating ?? null;

    const features = buildFeatureVector({
      cosineScore: cosine,
      daysSinceLastWatch,
      candidateRuntime: title.runtime,
      userMedianRuntime,
      genreAffinity: affinity,
      sourceRating,
    });

    if (row.action === "picked") {
      // A pick is an intention, not an outcome — resolve what actually
      // happened before training on it. Anything not confirmed watched is
      // EXCLUDED, never turned into a negative: see the header of
      // pickOutcome.ts for why a false negative is worse than no row.
      const outcome = resolvePickOutcome(userId, row.tmdbId, mediaType, row.createdAt, readBaseline(row.contextJson));
      if (outcome.kind !== "watched") continue;
      examples.push({ features, label: 1 });
    } else {
      // skipped / snoozed: explicit statements from someone looking straight
      // at the title. Complete the moment they happen, nothing to resolve.
      examples.push({ features, label: 0 });
    }
  }

  const existing = db.select().from(ltrModels).where(eq(ltrModels.userId, userId)).get();
  let initial: LtrModel | undefined;
  if (existing) {
    try {
      const parsed = JSON.parse(existing.weights);
      if (Array.isArray(parsed)) initial = { weights: parsed, bias: existing.bias };
    } catch {
      initial = undefined;
    }
  }

  const model = trainLogisticSgd(examples, { initial });

  db.insert(ltrModels)
    .values({
      userId,
      weights: JSON.stringify(model.weights),
      bias: model.bias,
      trainingCount: examples.length,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: ltrModels.userId,
      set: {
        weights: JSON.stringify(model.weights),
        bias: model.bias,
        trainingCount: examples.length,
        updatedAt: new Date(),
      },
    })
    .run();

  return { trained: true, numLabeled: examples.length };
}

/** Loads a user's persisted LTR model for serving, or null if there isn't
 *  one yet or it was trained on fewer than the gating threshold (defensive:
 *  a row could in principle predate a threshold change). Callers MUST treat
 *  null as "fall back to content-(+CF-)only scoring," never as an error. */
export function loadLtrModel(userId: string): LtrModel | null {
  const row = db.select().from(ltrModels).where(eq(ltrModels.userId, userId)).get();
  if (!row) return null;
  if (row.trainingCount < LTR_MIN_LABELED_INTERACTIONS) return null;
  try {
    const weights = JSON.parse(row.weights);
    if (!Array.isArray(weights)) return null;
    return { weights, bias: row.bias };
  } catch {
    return null;
  }
}
