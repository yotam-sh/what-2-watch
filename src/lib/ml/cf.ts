// ---------------------------------------------------------------------------
// Collaborative filtering — implicit-feedback ALS, hand-rolled in plain
// TypeScript (constraint 22: onnxruntime-node is inference-only, there is no
// ONNX training API, and at this data scale hand-rolled training is entirely
// reasonable). Matrix-factorization math follows Hu/Koren/Volinsky's
// "Collaborative Filtering for Implicit Feedback Datasets": confidence
// c_ui = 1 + alpha*r_ui, preference p_ui = 1{r_ui > 0}, alternating between
// solving a small regularized k x k linear system per user and per item.
//
// GATING (constraint 23 — cold start is real): trainAndPersistCf() only
// trains when meetsCfTrainingThreshold() is true; below it, this module
// changes nothing and the caller (recommend.ts) silently falls back to
// content-based scoring. getCfScoresForUser() gates a second, finer time:
// even once CF is trained globally, any individual user with no persisted
// factor row (never interacted at training time — including every brand-new
// signup) gets null back, not a crash or a zero-filled guess.
//
// Training is offline/on-demand only (see trainAndPersistCf, invoked by an
// operator or a scheduled job — there is no scheduler yet, matching Phase 2's
// "no background job scheduler" note) — never inside the request path that
// serves /api/recommend.
// ---------------------------------------------------------------------------

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { cfItemFactors, cfUserFactors, interactions, watchEvents } from "@/db/schema";
import { decodeVector, encodeVector } from "./embed";
import type { MediaType, TitleIdentity } from "./key";
import { titleKey } from "./key";
import { mulberry32 } from "./score";

// ---------------------------------------------------------------------------
// Gating thresholds — named constants, not magic numbers, per the plan.
// ---------------------------------------------------------------------------

/** ALS finds meaning in *cross-user* co-occurrence — "people who liked what
 *  you liked also liked X." With fewer than this many distinct users
 *  contributing signal, there's no meaningful cross-user structure to find;
 *  the factorization would just be overfitting noise to a handful of
 *  individual watch histories, which content-based scoring already covers
 *  better (and honestly). */
export const CF_MIN_USERS = 5;

/** Minimum total positive (watched, or explicitly "picked") signals across
 *  ALL users combined. This is the secondary gate — CF_MIN_USERS is the one
 *  that actually matters for whether cross-user patterns exist — it just
 *  guards against e.g. 5 users who each have only 2 watch_events rows. A
 *  single actively-synced Plex library typically produces hundreds of
 *  watch_events on its own, so 200 combined is a low bar once the user-count
 *  gate is already satisfied. */
export const CF_MIN_POSITIVE_SIGNALS = 200;

export function meetsCfTrainingThreshold(numUsers: number, numPositiveSignals: number): boolean {
  return numUsers >= CF_MIN_USERS && numPositiveSignals >= CF_MIN_POSITIVE_SIGNALS;
}

// ---------------------------------------------------------------------------
// Pure ALS — no DB. Operates on plain index-based sparse matrices so it's
// directly unit-testable with synthetic data (see cf.test.ts).
// ---------------------------------------------------------------------------

export const CF_DEFAULT_FACTORS = 8;
export const CF_DEFAULT_ITERATIONS = 15;
export const CF_DEFAULT_REGULARIZATION = 0.1;
export const CF_DEFAULT_ALPHA = 40;

export interface AlsOptions {
  factors?: number;
  iterations?: number;
  regularization?: number;
  alpha?: number;
  seed?: number;
}

export interface AlsInput {
  /** Sparse: userIndex -> Map<itemIndex, rawPositiveCount>. Absent entries
   *  are implicit negatives (p_ui = 0), per the implicit-feedback model —
   *  never build a dense matrix here. */
  userItemCounts: Map<number, Map<number, number>>;
  numUsers: number;
  numItems: number;
}

export interface AlsResult {
  userFactors: Float32Array[]; // length numUsers
  itemFactors: Float32Array[]; // length numItems
}

/** Explicit `new Float32Array(n)` + fill loop rather than `Float32Array.from`
 *  — both produce identical runtime values, but `.from()`'s inferred type
 *  (`Float32Array<ArrayBufferLike>`) doesn't structurally match the plain
 *  `Float32Array` (`<ArrayBuffer>`) this module's interfaces declare, under
 *  the TS lib's newer generic ArrayBuffer typing. */
function toFloat32Array(values: number[]): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i];
  return out;
}

function randomFloat32Array(length: number, rand: () => number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (rand() - 0.5) * 0.1;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

function transpose(byRow: Map<number, Map<number, number>>): Map<number, Map<number, number>> {
  const result = new Map<number, Map<number, number>>();
  for (const [row, cols] of byRow) {
    for (const [col, value] of cols) {
      let bucket = result.get(col);
      if (!bucket) {
        bucket = new Map();
        result.set(col, bucket);
      }
      bucket.set(row, value);
    }
  }
  return result;
}

function zeroMatrix(k: number): number[][] {
  return Array.from({ length: k }, () => new Array<number>(k).fill(0));
}

function outerAddInPlace(A: number[][], y: Float32Array, weight: number): void {
  const k = y.length;
  for (let i = 0; i < k; i++) {
    const yi = y[i];
    if (yi === 0) continue;
    for (let j = 0; j < k; j++) A[i][j] += weight * yi * y[j];
  }
}

/** Gauss-Jordan elimination with partial pivoting. k is small (default 8),
 *  so O(k^3) per solve is trivial — this runs once per user/item per ALS
 *  iteration. A near-singular pivot (a row/item with too little signal to
 *  constrain that dimension) resolves to 0 for that coordinate rather than
 *  blowing up, which is the right behavior under L2 regularization anyway
 *  (the regularizer already pulls under-determined dimensions toward 0). */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > maxVal) {
        maxVal = Math.abs(M[r][col]);
        pivotRow = r;
      }
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-10) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const pivot = M[i][i];
    x[i] = Math.abs(pivot) < 1e-10 ? 0 : M[i][n] / pivot;
  }
  return x;
}

/** Solves for one side's factors (users, holding item factors fixed, or vice
 *  versa) via the efficient implicit-ALS normal equations:
 *  (Y^T Y + Y^T(C_u - I)Y + lambda*I) x_u = Y^T C_u p_u, computed by
 *  precomputing Y^T Y once and only summing the (C_u - I) correction over
 *  each row's OBSERVED entries (everything else contributes 0 by
 *  construction of the implicit model). */
function solveFactors(
  observationsByRow: Map<number, Map<number, number>>,
  otherFactors: Float32Array[],
  numRows: number,
  k: number,
  lambda: number,
  alpha: number,
): Float32Array[] {
  const YtY = zeroMatrix(k);
  for (const y of otherFactors) outerAddInPlace(YtY, y, 1);

  const result: Float32Array[] = [];
  for (let r = 0; r < numRows; r++) {
    const obs = observationsByRow.get(r);
    const A = YtY.map((row) => [...row]);
    for (let i = 0; i < k; i++) A[i][i] += lambda;
    const b = new Array<number>(k).fill(0);

    if (obs) {
      for (const [itemIdx, count] of obs) {
        const y = otherFactors[itemIdx];
        if (!y) continue;
        const c = 1 + alpha * count;
        outerAddInPlace(A, y, c - 1);
        for (let i = 0; i < k; i++) b[i] += c * y[i];
      }
    }

    result.push(toFloat32Array(solveLinearSystem(A, b)));
  }
  return result;
}

export function trainAls(input: AlsInput, options: AlsOptions = {}): AlsResult {
  const k = options.factors ?? CF_DEFAULT_FACTORS;
  const iterations = options.iterations ?? CF_DEFAULT_ITERATIONS;
  const lambda = options.regularization ?? CF_DEFAULT_REGULARIZATION;
  const alpha = options.alpha ?? CF_DEFAULT_ALPHA;
  const rand = mulberry32(options.seed ?? 42);

  let userFactors = Array.from({ length: input.numUsers }, () => randomFloat32Array(k, rand));
  let itemFactors = Array.from({ length: input.numItems }, () => randomFloat32Array(k, rand));

  const itemUserCounts = transpose(input.userItemCounts);

  for (let iter = 0; iter < iterations; iter++) {
    userFactors = solveFactors(input.userItemCounts, itemFactors, input.numUsers, k, lambda, alpha);
    itemFactors = solveFactors(itemUserCounts, userFactors, input.numItems, k, lambda, alpha);
  }

  return { userFactors, itemFactors };
}

/** Raw ALS affinity score (unbounded, larger = more preferred) — just the
 *  dot product of a user factor and an item factor, per the implicit-ALS
 *  model. Not a cosine similarity: ALS factors are not unit-normalized. */
export function predictAlsScore(userFactor: Float32Array, itemFactor: Float32Array): number {
  return dot(userFactor, itemFactor);
}

// ---------------------------------------------------------------------------
// DB orchestration — not unit-tested directly (same convention as
// store.ts/librarySync.ts: needs a real DB connection to exercise). The pure
// math above and the gating threshold are what's tested.
// ---------------------------------------------------------------------------

interface RawSignal extends TitleIdentity {
  userId: string;
  weight: number;
}

/** Positive implicit signal = watched (any watch_events row) or explicitly
 *  "picked" from a recommend roll (interactions row with action='picked').
 *  Both count toward the same (user, title) cell; watching AND picking the
 *  same title contributes weight 2, which is intentionally stronger signal
 *  than either alone. */
function loadPositiveSignals(): RawSignal[] {
  const watchRows = db
    .select({ userId: watchEvents.userId, tmdbId: watchEvents.tmdbId, mediaType: watchEvents.mediaType })
    .from(watchEvents)
    .all();
  const pickedRows = db
    .select({ userId: interactions.userId, tmdbId: interactions.tmdbId, mediaType: interactions.mediaType })
    .from(interactions)
    .where(eq(interactions.action, "picked"))
    .all();

  const byKey = new Map<string, RawSignal>();
  const bump = (userId: string, tmdbId: number, mediaType: MediaType) => {
    const k = `${userId}::${tmdbId}:${mediaType}`;
    const existing = byKey.get(k);
    if (existing) existing.weight += 1;
    else byKey.set(k, { userId, tmdbId, mediaType, weight: 1 });
  };
  for (const r of watchRows) bump(r.userId, r.tmdbId, r.mediaType as MediaType);
  for (const r of pickedRows) bump(r.userId, r.tmdbId, r.mediaType as MediaType);
  return [...byKey.values()];
}

export interface CfTrainResult {
  trained: boolean;
  numUsers: number;
  numPositiveSignals: number;
  numItems: number;
}

/** Trains ALS over every user's combined signal and persists both factor
 *  matrices, or does nothing and reports why if the gate isn't met. Call
 *  this from an operator-triggered job, not from the request path. */
export function trainAndPersistCf(options: AlsOptions = {}): CfTrainResult {
  const signals = loadPositiveSignals();
  const userIds = [...new Set(signals.map((s) => s.userId))];
  const numUsers = userIds.length;
  const numPositiveSignals = signals.length;

  if (!meetsCfTrainingThreshold(numUsers, numPositiveSignals)) {
    return { trained: false, numUsers, numPositiveSignals, numItems: 0 };
  }

  const itemKeys = [...new Set(signals.map((s) => titleKey(s)))];
  const userIndex = new Map(userIds.map((id, i) => [id, i]));
  const itemIndex = new Map(itemKeys.map((k, i) => [k, i]));
  const itemIdentity = new Map<string, TitleIdentity>();
  for (const s of signals) itemIdentity.set(titleKey(s), { tmdbId: s.tmdbId, mediaType: s.mediaType });

  const userItemCounts = new Map<number, Map<number, number>>();
  for (const s of signals) {
    const ui = userIndex.get(s.userId)!;
    const ii = itemIndex.get(titleKey(s))!;
    let row = userItemCounts.get(ui);
    if (!row) {
      row = new Map();
      userItemCounts.set(ui, row);
    }
    row.set(ii, (row.get(ii) ?? 0) + s.weight);
  }

  const { userFactors, itemFactors } = trainAls(
    { userItemCounts, numUsers, numItems: itemKeys.length },
    options,
  );

  const now = new Date();
  db.transaction((tx) => {
    for (const [userId, idx] of userIndex) {
      const encoded = encodeVector(userFactors[idx]);
      tx.insert(cfUserFactors)
        .values({ userId, factors: encoded, updatedAt: now })
        .onConflictDoUpdate({ target: cfUserFactors.userId, set: { factors: encoded, updatedAt: now } })
        .run();
    }
    for (const [key, idx] of itemIndex) {
      const identity = itemIdentity.get(key)!;
      const encoded = encodeVector(itemFactors[idx]);
      tx.insert(cfItemFactors)
        .values({ tmdbId: identity.tmdbId, mediaType: identity.mediaType, factors: encoded, updatedAt: now })
        .onConflictDoUpdate({
          target: [cfItemFactors.tmdbId, cfItemFactors.mediaType],
          set: { factors: encoded, updatedAt: now },
        })
        .run();
    }
  });

  return { trained: true, numUsers, numPositiveSignals, numItems: itemKeys.length };
}

/** Looks up CF scores for a set of candidates for one user. Returns null —
 *  never throws, never guesses — when this user has no persisted factor row
 *  (CF was never trained, or this user had no signal at training time,
 *  including every brand-new signup). Candidates with no persisted item
 *  factor (e.g. a title added after the last training run) are simply
 *  absent from the returned map; treat a missing key as "no CF signal,"
 *  same as a null return, not as 0 preference. */
export function getCfScoresForUser(userId: string, candidates: TitleIdentity[]): Map<string, number> | null {
  const userRow = db.select().from(cfUserFactors).where(eq(cfUserFactors.userId, userId)).get();
  if (!userRow) return null;
  if (candidates.length === 0) return new Map();

  const userFactor = decodeVector(userRow.factors);
  const tmdbIds = [...new Set(candidates.map((c) => c.tmdbId))];
  const rows = db
    .select()
    .from(cfItemFactors)
    .where(and(inArray(cfItemFactors.tmdbId, tmdbIds)))
    .all();

  const wanted = new Set(candidates.map(titleKey));
  const scores = new Map<string, number>();
  for (const row of rows) {
    const key = titleKey({ tmdbId: row.tmdbId, mediaType: row.mediaType as MediaType });
    if (!wanted.has(key)) continue;
    scores.set(key, predictAlsScore(userFactor, decodeVector(row.factors)));
  }
  return scores;
}
