import { describe, expect, it, vi } from "vitest";

// cf.ts imports the shared `db` singleton from @/db/client at module scope
// (for its DB-orchestration exports, e.g. trainAndPersistCf), and that
// module eagerly opens the real ./data/app.db with the real
// SERVER_ENCRYPTION_KEY as a side effect of being imported — which doesn't
// match this test run's fake key (see vitest.config.ts), and would fail
// even for a test that only exercises the pure ALS math below and never
// touches the DB. Stub it out so importing cf.ts never triggers that side
// effect; none of these tests call the DB-orchestration exports.
vi.mock("@/db/client", () => ({ db: {}, sqlite: {} }));

import { CF_MIN_POSITIVE_SIGNALS, CF_MIN_USERS, meetsCfTrainingThreshold, predictAlsScore, trainAls } from "./cf";

describe("meetsCfTrainingThreshold — gating", () => {
  it("is false with too few users, even with plenty of signal", () => {
    expect(meetsCfTrainingThreshold(CF_MIN_USERS - 1, CF_MIN_POSITIVE_SIGNALS * 10)).toBe(false);
  });

  it("is false with too little signal, even with plenty of users", () => {
    expect(meetsCfTrainingThreshold(CF_MIN_USERS * 10, CF_MIN_POSITIVE_SIGNALS - 1)).toBe(false);
  });

  it("is true once both thresholds are met", () => {
    expect(meetsCfTrainingThreshold(CF_MIN_USERS, CF_MIN_POSITIVE_SIGNALS)).toBe(true);
  });

  it("is false for a brand-new deployment (0 users, 0 signals) — cold start", () => {
    expect(meetsCfTrainingThreshold(0, 0)).toBe(false);
  });
});

describe("trainAls — synthetic recovery of cross-user taste clusters", () => {
  // 3 "action fans" who all watched items 0,1,2; 3 "romance fans" who all
  // watched items 3,4,5. A correct implicit-ALS factorization should learn
  // user/item factors such that each fan's dot product with their own
  // cluster's items is higher than with the other cluster's items.
  function buildClusteredMatrix() {
    const userItemCounts = new Map<number, Map<number, number>>();
    // users 0,1,2 -> items 0,1,2 (action)
    for (let u = 0; u < 3; u++) {
      const row = new Map<number, number>();
      for (let i = 0; i < 3; i++) row.set(i, 3); // watched 3 times each
      userItemCounts.set(u, row);
    }
    // users 3,4,5 -> items 3,4,5 (romance)
    for (let u = 3; u < 6; u++) {
      const row = new Map<number, number>();
      for (let i = 3; i < 6; i++) row.set(i, 3);
      userItemCounts.set(u, row);
    }
    return { userItemCounts, numUsers: 6, numItems: 6 };
  }

  it("gives each user cluster a higher affinity for its own cluster's items", () => {
    const input = buildClusteredMatrix();
    const { userFactors, itemFactors } = trainAls(input, { factors: 4, iterations: 20, seed: 1 });

    for (const u of [0, 1, 2]) {
      const ownScore = predictAlsScore(userFactors[u], itemFactors[0]);
      const otherScore = predictAlsScore(userFactors[u], itemFactors[3]);
      expect(ownScore).toBeGreaterThan(otherScore);
    }
    for (const u of [3, 4, 5]) {
      const ownScore = predictAlsScore(userFactors[u], itemFactors[4]);
      const otherScore = predictAlsScore(userFactors[u], itemFactors[1]);
      expect(ownScore).toBeGreaterThan(otherScore);
    }
  });

  it("is deterministic given the same seed", () => {
    const input = buildClusteredMatrix();
    const a = trainAls(input, { factors: 4, iterations: 10, seed: 7 });
    const b = trainAls(input, { factors: 4, iterations: 10, seed: 7 });
    expect(Array.from(a.userFactors[0])).toEqual(Array.from(b.userFactors[0]));
    expect(Array.from(a.itemFactors[0])).toEqual(Array.from(b.itemFactors[0]));
  });

  it("handles a user with zero observations (cold-start user inside a trained model) without producing NaN", () => {
    const input = buildClusteredMatrix();
    input.userItemCounts.delete(0); // user 0 has no observations at all
    const { userFactors } = trainAls(input, { factors: 4, iterations: 5, seed: 1 });
    expect(Array.from(userFactors[0]).every((v) => Number.isFinite(v))).toBe(true);
  });

  it("handles a completely empty matrix without throwing", () => {
    expect(() => trainAls({ userItemCounts: new Map(), numUsers: 0, numItems: 0 }, { factors: 4 })).not.toThrow();
  });
});
