import { describe, expect, it } from "vitest";
import { l2Normalize } from "./embed";
import {
  applyHardFilters,
  applyRecencyDecay,
  applySeededJitter,
  buildGenreAffinity,
  centroidWeight,
  computeCentroid,
  computeMedianRuntime,
  contentScore,
  deriveSeed,
  genreAffinityScore,
  MIN_RATING_FOR_CENTROID,
  MIN_VIEWCOUNT_FOR_CENTROID,
  rankBinge,
  selectCentroidSignals,
  type BingeCandidate,
  type FilterableCandidate,
  type WatchSignal,
} from "./score";

const MOVIE = "movie" as const;
const TV = "tv" as const;

function vec(...xs: number[]): Float32Array {
  return l2Normalize(new Float32Array(xs));
}

describe("centroidWeight — unrated is not a 0-star film", () => {
  it("weights an unrated-but-rewatched title above zero", () => {
    const w = centroidWeight({ tmdbId: 1, mediaType: MOVIE, letterboxdRating: null, viewCount: 3 });
    expect(w).toBeGreaterThan(0);
  });

  it("uses the explicit rating instead of viewCount whenever a rating is present — even a low rating with a huge viewCount", () => {
    // rating=2 -> weight 2/5=0.4. If viewCount had been used instead, 1000
    // would cap at weight 1 — so this only holds if rating truly always
    // takes precedence over viewCount, not just "usually produces a bigger
    // number."
    const w = centroidWeight({ tmdbId: 1, mediaType: MOVIE, letterboxdRating: 2, viewCount: 1000 });
    expect(w).toBeCloseTo(0.4, 5);
  });

  it("caps the viewCount contribution so obsessive rewatches don't dominate", () => {
    const capped = centroidWeight({ tmdbId: 1, mediaType: MOVIE, letterboxdRating: null, viewCount: 1000 });
    expect(capped).toBeLessThanOrEqual(1);
  });

  it("floors a qualifying low rating above 0", () => {
    const w = centroidWeight({ tmdbId: 1, mediaType: MOVIE, letterboxdRating: MIN_RATING_FOR_CENTROID, viewCount: 0 });
    expect(w).toBeGreaterThan(0);
  });
});

describe("selectCentroidSignals", () => {
  it("includes highly-rated titles", () => {
    const signals: WatchSignal[] = [{ tmdbId: 1, mediaType: MOVIE, letterboxdRating: 4.5, viewCount: 0 }];
    expect(selectCentroidSignals(signals)).toHaveLength(1);
  });

  it("includes rewatched-but-unrated titles", () => {
    const signals: WatchSignal[] = [
      { tmdbId: 1, mediaType: MOVIE, letterboxdRating: null, viewCount: MIN_VIEWCOUNT_FOR_CENTROID },
    ];
    expect(selectCentroidSignals(signals)).toHaveLength(1);
  });

  it("excludes a low rating watched only once", () => {
    const signals: WatchSignal[] = [{ tmdbId: 1, mediaType: MOVIE, letterboxdRating: 2, viewCount: 1 }];
    expect(selectCentroidSignals(signals)).toHaveLength(0);
  });
});

describe("computeCentroid", () => {
  it("returns null with no signals (cold start)", () => {
    expect(computeCentroid([], new Map())).toBeNull();
  });

  it("returns null when signals exist but none have an embedding yet", () => {
    const signals: WatchSignal[] = [{ tmdbId: 1, mediaType: MOVIE, letterboxdRating: 5, viewCount: 0 }];
    expect(computeCentroid(signals, new Map())).toBeNull();
  });

  it("weights an unrated-rewatched title into the centroid, not zero", () => {
    const embeddings = new Map([["1:movie", vec(1, 0)]]);
    const signals: WatchSignal[] = [{ tmdbId: 1, mediaType: MOVIE, letterboxdRating: null, viewCount: 4 }];
    const centroid = computeCentroid(signals, embeddings);
    expect(centroid).not.toBeNull();
    expect(contentScore(vec(1, 0), centroid)).toBeCloseTo(1, 4);
  });

  it("a 5-star title pulls the centroid toward it more than a barely-qualifying one", () => {
    const embeddings = new Map([
      ["1:movie", vec(1, 0)], // 5-star
      ["2:movie", vec(0, 1)], // barely-qualifying rewatch
    ]);
    const signals: WatchSignal[] = [
      { tmdbId: 1, mediaType: MOVIE, letterboxdRating: 5, viewCount: 0 },
      { tmdbId: 2, mediaType: MOVIE, letterboxdRating: null, viewCount: MIN_VIEWCOUNT_FOR_CENTROID },
    ];
    const centroid = computeCentroid(signals, embeddings)!;
    // Centroid should lean toward (1,0) more than toward (0,1).
    expect(centroid[0]).toBeGreaterThan(centroid[1]);
  });

  it("is normalized to unit length", () => {
    const embeddings = new Map([
      ["1:movie", vec(1, 0)],
      ["2:movie", vec(0, 1)],
    ]);
    const signals: WatchSignal[] = [
      { tmdbId: 1, mediaType: MOVIE, letterboxdRating: 5, viewCount: 0 },
      { tmdbId: 2, mediaType: MOVIE, letterboxdRating: 5, viewCount: 0 },
    ];
    const centroid = computeCentroid(signals, embeddings)!;
    const norm = Math.sqrt(centroid[0] ** 2 + centroid[1] ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("contentScore — cold start safety", () => {
  it("returns 0 (neutral) when there's no centroid", () => {
    expect(contentScore(vec(1, 0), null)).toBe(0);
  });

  it("returns 0 when the candidate has no embedding", () => {
    expect(contentScore(null, vec(1, 0))).toBe(0);
  });

  it("never throws for null/null", () => {
    expect(() => contentScore(null, null)).not.toThrow();
  });
});

describe("applyHardFilters", () => {
  const base: FilterableCandidate[] = [
    { tmdbId: 1, mediaType: MOVIE, runtime: 90, year: 1995, genres: ["Comedy"] },
    { tmdbId: 2, mediaType: MOVIE, runtime: 150, year: 2005, genres: ["Drama", "War"] },
    { tmdbId: 3, mediaType: MOVIE, runtime: 100, year: null, genres: [] },
  ];

  it("filters by max runtime", () => {
    const result = applyHardFilters(base, { maxRuntimeMinutes: 100 });
    expect(result.map((c) => c.tmdbId)).toEqual([1, 3]);
  });

  it("excludes candidates with unknown runtime when a max is set", () => {
    const withUnknown: FilterableCandidate[] = [{ tmdbId: 9, mediaType: MOVIE, runtime: null, year: 2000, genres: [] }];
    expect(applyHardFilters(withUnknown, { maxRuntimeMinutes: 120 })).toHaveLength(0);
  });

  it("filters by decade", () => {
    const result = applyHardFilters(base, { decade: 1990 });
    expect(result.map((c) => c.tmdbId)).toEqual([1]);
  });

  it("excludes candidates with unknown year when a decade is set", () => {
    const result = applyHardFilters(base, { decade: 1990 });
    expect(result.find((c) => c.tmdbId === 3)).toBeUndefined();
  });

  it("filters by includeGenres (at least one match)", () => {
    const result = applyHardFilters(base, { includeGenres: ["War"] });
    expect(result.map((c) => c.tmdbId)).toEqual([2]);
  });

  it("filters by excludeGenres (none may match)", () => {
    const result = applyHardFilters(base, { excludeGenres: ["Drama"] });
    expect(result.map((c) => c.tmdbId)).toEqual([1, 3]);
  });

  it("filters rewatch mode's 'not watched in the last N months'", () => {
    const now = Date.parse("2026-08-22T00:00:00Z");
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const sixMonthsAgo = now - 6 * 30 * 24 * 60 * 60 * 1000;
    const lastWatchedAtByKey = new Map([
      ["1:movie", oneMonthAgo],
      ["2:movie", sixMonthsAgo],
      // 3:movie never watched — absent from the map entirely.
    ]);
    const result = applyHardFilters(base, { minMonthsSinceWatched: 3 }, { lastWatchedAtByKey, now });
    expect(result.map((c) => c.tmdbId).sort()).toEqual([2, 3]);
  });

  it("combines multiple filters (AND semantics)", () => {
    const result = applyHardFilters(base, { maxRuntimeMinutes: 160, includeGenres: ["Drama"] });
    expect(result.map((c) => c.tmdbId)).toEqual([2]);
  });

  it("with no filters set, returns everything unchanged", () => {
    expect(applyHardFilters(base, {})).toHaveLength(3);
  });
});

describe("applyRecencyDecay", () => {
  it("penalizes a recently-watched title more than an old one", () => {
    const now = Date.now();
    const scored = [
      { key: "1:movie", score: 1 },
      { key: "2:movie", score: 1 },
    ];
    const lastWatchedAtByKey = new Map([
      ["1:movie", now - 1 * 24 * 60 * 60 * 1000], // watched yesterday
      ["2:movie", now - 300 * 24 * 60 * 60 * 1000], // watched ~10 months ago
    ]);
    const result = applyRecencyDecay(scored, { lastWatchedAtByKey, now });
    const recent = result.find((r) => r.key === "1:movie")!;
    const old = result.find((r) => r.key === "2:movie")!;
    expect(recent.score).toBeLessThan(old.score);
  });

  it("penalizes a recently-shown title even if never watched", () => {
    const now = Date.now();
    const scored = [
      { key: "1:movie", score: 1 },
      { key: "2:movie", score: 1 },
    ];
    const lastShownAtByKey = new Map([["1:movie", now - 1 * 60 * 60 * 1000]]); // shown 1h ago
    const result = applyRecencyDecay(scored, { lastShownAtByKey, now });
    const shown = result.find((r) => r.key === "1:movie")!;
    const neverShown = result.find((r) => r.key === "2:movie")!;
    expect(shown.score).toBeLessThan(neverShown.score);
  });

  it("leaves untouched candidates with no watch/shown history unchanged", () => {
    const scored = [{ key: "1:movie", score: 0.5 }];
    const result = applyRecencyDecay(scored, {});
    expect(result[0].score).toBe(0.5);
  });
});

describe("deriveSeed / applySeededJitter — deterministic 'roll again'", () => {
  it("the same seed always produces the same order", () => {
    const scored = [
      { key: "1:movie", score: 0.5 },
      { key: "2:movie", score: 0.5 },
      { key: "3:movie", score: 0.5 },
      { key: "4:movie", score: 0.5 },
    ];
    const a = applySeededJitter(scored, 12345);
    const b = applySeededJitter(scored, 12345);
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
  });

  it("different seeds can produce different orders (variety)", () => {
    const scored = Array.from({ length: 8 }, (_, i) => ({ key: `${i}:movie`, score: 0.5 }));
    const orders = new Set(
      [1, 2, 3, 4, 5].map((seed) => applySeededJitter(scored, seed).map((c) => c.key).join(",")),
    );
    // With tied base scores and 5 different seeds, we should see more than
    // one distinct ordering — otherwise jitter isn't doing anything.
    expect(orders.size).toBeGreaterThan(1);
  });

  it("a strong score lead is not overturned by jitter", () => {
    const scored = [
      { key: "winner:movie", score: 10 },
      { key: "loser:movie", score: -10 },
    ];
    const result = applySeededJitter(scored, 999);
    expect(result[0].key).toBe("winner:movie");
  });

  it("deriveSeed is stable for the same user/day and an explicit seed always wins", () => {
    const a = deriveSeed("user-1");
    const b = deriveSeed("user-1");
    expect(a).toBe(b);
    expect(deriveSeed("user-1", 42)).toBe(42);
  });

  it("deriveSeed differs across users", () => {
    expect(deriveSeed("user-1")).not.toBe(deriveSeed("user-2"));
  });
});

describe("rankBinge — prefers short complete seasons over sprawling shows", () => {
  it("ranks a 6-episode complete season above a 9-season procedural's tail end", () => {
    const shortSeason: BingeCandidate = {
      tmdbId: 1,
      mediaType: TV,
      runtime: 45,
      leafCount: 6,
      viewedLeafCount: 0,
    };
    const longRunningProcedural: BingeCandidate = {
      tmdbId: 2,
      mediaType: TV,
      runtime: 45,
      leafCount: 200,
      viewedLeafCount: 190, // only 10 episodes "remaining" — deceptively close in raw count
    };
    const ranked = rankBinge([longRunningProcedural, shortSeason]);
    expect(ranked[0].tmdbId).toBe(1);
  });

  it("excludes fully-watched shows", () => {
    const finished: BingeCandidate = { tmdbId: 1, mediaType: TV, runtime: 30, leafCount: 10, viewedLeafCount: 10 };
    expect(rankBinge([finished])).toHaveLength(0);
  });

  it("excludes shows with no leafCount on file (never synced)", () => {
    const unknown: BingeCandidate = { tmdbId: 1, mediaType: TV, runtime: 30, leafCount: null, viewedLeafCount: null };
    expect(rankBinge([unknown])).toHaveLength(0);
  });

  it("prefers less remaining runtime when total scale is equal", () => {
    const shorter: BingeCandidate = { tmdbId: 1, mediaType: TV, runtime: 20, leafCount: 10, viewedLeafCount: 5 };
    const longer: BingeCandidate = { tmdbId: 2, mediaType: TV, runtime: 60, leafCount: 10, viewedLeafCount: 5 };
    const ranked = rankBinge([longer, shorter]);
    expect(ranked[0].tmdbId).toBe(1);
  });

  it("falls back to a default per-episode runtime when runtime is unknown", () => {
    const noRuntime: BingeCandidate = { tmdbId: 1, mediaType: TV, runtime: null, leafCount: 6, viewedLeafCount: 0 };
    const ranked = rankBinge([noRuntime]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].remainingRuntimeMinutes).toBeGreaterThan(0);
  });
});

describe("buildGenreAffinity / genreAffinityScore", () => {
  it("is empty (cold-start-safe) with no signals", () => {
    const affinity = buildGenreAffinity([], new Map());
    expect(genreAffinityScore(["Comedy"], affinity)).toBe(0);
  });

  it("scores a candidate whose genres match the user's strongest signal highest", () => {
    const genresByKey = new Map([
      ["1:movie", ["Horror"]],
      ["2:movie", ["Comedy"]],
    ]);
    const signals: WatchSignal[] = [
      { tmdbId: 1, mediaType: MOVIE, letterboxdRating: 5, viewCount: 0 },
      { tmdbId: 2, mediaType: MOVIE, letterboxdRating: null, viewCount: MIN_VIEWCOUNT_FOR_CENTROID },
    ];
    const affinity = buildGenreAffinity(signals, genresByKey);
    expect(genreAffinityScore(["Horror"], affinity)).toBeGreaterThan(genreAffinityScore(["Comedy"], affinity));
  });

  it("returns 0 for a candidate with no genres", () => {
    const affinity = buildGenreAffinity(
      [{ tmdbId: 1, mediaType: MOVIE, letterboxdRating: 5, viewCount: 0 }],
      new Map([["1:movie", ["Horror"]]]),
    );
    expect(genreAffinityScore([], affinity)).toBe(0);
  });
});

describe("computeMedianRuntime", () => {
  it("computes the median of odd-length input", () => {
    expect(computeMedianRuntime([90, 100, 110])).toBe(100);
  });

  it("computes the median of even-length input", () => {
    expect(computeMedianRuntime([90, 100, 110, 120])).toBe(105);
  });

  it("ignores null/undefined/zero/negative entries", () => {
    expect(computeMedianRuntime([null, 100, undefined, 0, -5])).toBe(100);
  });

  it("returns null when there's nothing valid", () => {
    expect(computeMedianRuntime([null, undefined, 0])).toBeNull();
  });
});
