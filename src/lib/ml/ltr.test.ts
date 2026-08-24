import { describe, expect, it, vi } from "vitest";

// See cf.test.ts's identical comment: ltr.ts also imports the shared `db`
// singleton at module scope for its DB-orchestration exports, which would
// otherwise eagerly open the real ./data/app.db under a mismatched test key
// just from importing this module — stubbed out since none of these tests
// touch the DB-orchestration exports.
vi.mock("@/db/client", () => ({ db: {}, sqlite: {} }));

import {
  LTR_MIN_LABELED_INTERACTIONS,
  buildFeatureVector,
  meetsLtrTrainingThreshold,
  predict,
  trainLogisticSgd,
  type LtrExample,
} from "./ltr";

describe("meetsLtrTrainingThreshold — gating", () => {
  it("is false below the threshold, including 0 (cold start)", () => {
    expect(meetsLtrTrainingThreshold(0)).toBe(false);
    expect(meetsLtrTrainingThreshold(LTR_MIN_LABELED_INTERACTIONS - 1)).toBe(false);
  });

  it("is true at and above the threshold", () => {
    expect(meetsLtrTrainingThreshold(LTR_MIN_LABELED_INTERACTIONS)).toBe(true);
    expect(meetsLtrTrainingThreshold(LTR_MIN_LABELED_INTERACTIONS + 100)).toBe(true);
  });
});

describe("buildFeatureVector", () => {
  it("produces features in the documented fixed order", () => {
    const features = buildFeatureVector({
      cosineScore: 0.5,
      daysSinceLastWatch: 30,
      candidateRuntime: 120,
      userMedianRuntime: 100,
      genreAffinity: 0.7,
      sourceRating: 4,
    });
    expect(features).toHaveLength(5);
    expect(features[0]).toBe(0.5); // cosineScore passes through unscaled
    expect(features[4]).toBeCloseTo(0.8, 5); // sourceRating / 5
  });

  it("uses the 'never watched' sentinel when daysSinceLastWatch is null", () => {
    const withHistory = buildFeatureVector({
      cosineScore: 0,
      daysSinceLastWatch: 1,
      candidateRuntime: null,
      userMedianRuntime: null,
      genreAffinity: 0,
      sourceRating: null,
    });
    const neverWatched = buildFeatureVector({
      cosineScore: 0,
      daysSinceLastWatch: null,
      candidateRuntime: null,
      userMedianRuntime: null,
      genreAffinity: 0,
      sourceRating: null,
    });
    expect(neverWatched[1]).toBeGreaterThan(withHistory[1]);
  });

  it("saturates runtime delta at 1 rather than growing unbounded", () => {
    const huge = buildFeatureVector({
      cosineScore: 0,
      daysSinceLastWatch: null,
      candidateRuntime: 1000,
      userMedianRuntime: 90,
      genreAffinity: 0,
      sourceRating: null,
    });
    expect(huge[2]).toBe(1);
  });

  it("defaults runtimeDelta and sourceRating to neutral when data is missing", () => {
    const features = buildFeatureVector({
      cosineScore: 0,
      daysSinceLastWatch: null,
      candidateRuntime: null,
      userMedianRuntime: null,
      genreAffinity: 0,
      sourceRating: null,
    });
    expect(features[2]).toBe(0);
    expect(features[4]).toBe(0);
  });
});

describe("predict", () => {
  it("returns a probability in (0, 1)", () => {
    const p = predict([0.5, 0.5, 0.5, 0.5, 0.5], { weights: [1, 1, 1, 1, 1], bias: 0 });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("returns exactly 0.5 for an all-zero model", () => {
    expect(predict([1, 2, 3, 4, 5], { weights: [0, 0, 0, 0, 0], bias: 0 })).toBeCloseTo(0.5, 5);
  });

  it("a strongly positive linear combination predicts close to 1", () => {
    expect(predict([1, 1, 1, 1, 1], { weights: [10, 10, 10, 10, 10], bias: 0 })).toBeGreaterThan(0.99);
  });
});

describe("trainLogisticSgd", () => {
  it("returns the initial/zero model unchanged when there are no examples", () => {
    const model = trainLogisticSgd([]);
    expect(model.weights.every((w) => w === 0)).toBe(true);
    expect(model.bias).toBe(0);
  });

  it("learns to separate a trivially separable dataset (feature 0 alone determines the label)", () => {
    const examples: LtrExample[] = [];
    for (let i = 0; i < 20; i++) {
      examples.push({ features: [0.9, 0, 0, 0, 0], label: 1 });
      examples.push({ features: [0.1, 0, 0, 0, 0], label: 0 });
    }
    const model = trainLogisticSgd(examples, { seed: 1 });
    expect(predict([0.9, 0, 0, 0, 0], model)).toBeGreaterThan(0.7);
    expect(predict([0.1, 0, 0, 0, 0], model)).toBeLessThan(0.3);
  });

  it("is deterministic given the same seed", () => {
    const examples: LtrExample[] = Array.from({ length: 10 }, (_, i) => ({
      features: [i / 10, 0, 0, 0, 0],
      label: i % 2 === 0 ? 1 : 0,
    }));
    const a = trainLogisticSgd(examples, { seed: 3 });
    const b = trainLogisticSgd(examples, { seed: 3 });
    expect(a.weights).toEqual(b.weights);
    expect(a.bias).toBe(b.bias);
  });

  it("warm-starts from an initial model rather than always starting at zero", () => {
    const initial = { weights: [5, 0, 0, 0, 0], bias: 0 };
    const model = trainLogisticSgd([{ features: [0, 0, 0, 0, 0], label: 1 }], {
      initial,
      epochs: 1,
      learningRate: 0.001,
    });
    // One tiny-learning-rate epoch shouldn't have erased the warm-started weight.
    expect(model.weights[0]).toBeCloseTo(5, 1);
  });
});
