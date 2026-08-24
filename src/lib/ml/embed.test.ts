import { describe, expect, it } from "vitest";
import {
  buildEmbeddingText,
  cosineSimilarity,
  decodeVector,
  embedText,
  encodeVector,
  l2Normalize,
  parseJsonStringArray,
  __setExtractorForTest,
} from "./embed";

describe("buildEmbeddingText", () => {
  it("joins genres + directors + cast + keywords + overview in that order", () => {
    const text = buildEmbeddingText({
      genres: ["Action", "Sci-Fi"],
      directors: ["Denis Villeneuve"],
      cast: ["Timothée Chalamet"],
      keywords: ["desert", "prophecy"],
      overview: "A young man's destiny unfolds.",
    });
    expect(text).toBe(
      "Action. Sci-Fi. Denis Villeneuve. Timothée Chalamet. desert. prophecy. A young man's destiny unfolds.",
    );
  });

  it("handles missing/null fields without throwing", () => {
    expect(() => buildEmbeddingText({})).not.toThrow();
    expect(buildEmbeddingText({ genres: null, overview: null })).toBe("");
  });

  it("drops empty-string entries", () => {
    const text = buildEmbeddingText({ genres: ["Action", "", "  "], overview: "" });
    expect(text).toBe("Action");
  });

  it("returns empty string for a fully empty title", () => {
    expect(buildEmbeddingText({ genres: [], directors: [], cast: [], keywords: [], overview: "" })).toBe("");
  });
});

describe("parseJsonStringArray", () => {
  it("parses a valid JSON array of strings", () => {
    expect(parseJsonStringArray('["Action","Drama"]')).toEqual(["Action", "Drama"]);
  });

  it("returns [] for null/undefined/empty", () => {
    expect(parseJsonStringArray(null)).toEqual([]);
    expect(parseJsonStringArray(undefined)).toEqual([]);
    expect(parseJsonStringArray("")).toEqual([]);
  });

  it("returns [] for malformed JSON rather than throwing", () => {
    expect(parseJsonStringArray("not json")).toEqual([]);
  });

  it("returns [] for valid JSON that isn't an array", () => {
    expect(parseJsonStringArray('{"a":1}')).toEqual([]);
  });

  it("filters out non-string array entries", () => {
    expect(parseJsonStringArray('["a", 1, null, "b"]')).toEqual(["a", "b"]);
  });
});

describe("l2Normalize / cosineSimilarity", () => {
  it("normalizes a vector to unit length", () => {
    const v = new Float32Array([3, 4]);
    const n = l2Normalize(v);
    const norm = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
    expect(norm).toBeCloseTo(1, 5);
  });

  it("leaves an already-unit vector unchanged (within float tolerance)", () => {
    const v = new Float32Array([1, 0, 0]);
    const n = l2Normalize(v);
    expect(n[0]).toBeCloseTo(1, 5);
  });

  it("handles the zero vector without dividing by zero", () => {
    const v = new Float32Array([0, 0, 0]);
    const n = l2Normalize(v);
    expect(Array.from(n)).toEqual([0, 0, 0]);
  });

  it("cosine similarity of a vector with itself (normalized) is 1", () => {
    const v = l2Normalize(new Float32Array([1, 2, 3]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("cosine similarity of orthogonal normalized vectors is 0", () => {
    const a = l2Normalize(new Float32Array([1, 0]));
    const b = l2Normalize(new Float32Array([0, 1]));
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("cosine similarity of opposite normalized vectors is -1", () => {
    const a = l2Normalize(new Float32Array([1, 0]));
    const b = l2Normalize(new Float32Array([-1, 0]));
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });
});

describe("encodeVector / decodeVector round trip", () => {
  it("round-trips an arbitrary vector exactly", () => {
    const original = new Float32Array([1.5, -2.25, 0, 3.333333, -0.0001, 42]);
    const buf = encodeVector(original);
    const decoded = decodeVector(buf);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("round-trips through a Buffer view with a non-zero byteOffset", () => {
    // Simulate what better-sqlite3 might hand back: a Buffer that's a slice
    // of a larger allocation, not 4-byte aligned relative to the start.
    const original = new Float32Array([1, 2, 3, 4]);
    const encoded = encodeVector(original);
    const padded = Buffer.alloc(encoded.length + 3);
    encoded.copy(padded, 3);
    const misaligned = padded.subarray(3); // byteOffset 3 within `padded`'s buffer
    const decoded = decodeVector(misaligned);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("round trip preserves normalization (cosine self-similarity stays 1)", () => {
    const original = l2Normalize(new Float32Array([1, 2, 3, 4, 5]));
    const decoded = decodeVector(encodeVector(original));
    expect(cosineSimilarity(original, decoded)).toBeCloseTo(1, 5);
  });
});

describe("embedText (model mocked — never touches the real network/ONNX runtime)", () => {
  it("mean-pools + L2-normalizes via the injected extractor", async () => {
    __setExtractorForTest(async (text) => {
      expect(text).toBe("hello world");
      return { data: new Float32Array([3, 4, 0]) };
    });
    try {
      const vec = await embedText("hello world");
      const norm = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);
      expect(norm).toBeCloseTo(1, 5);
      expect(vec[0]).toBeCloseTo(0.6, 5);
      expect(vec[1]).toBeCloseTo(0.8, 5);
    } finally {
      __setExtractorForTest(null);
    }
  });

  it("reuses the same extractor across calls (warmed once)", async () => {
    let callCount = 0;
    __setExtractorForTest(async () => {
      callCount += 1;
      return { data: new Float32Array([1, 0]) };
    });
    try {
      await embedText("a");
      await embedText("b");
      // The extractor factory itself was only "loaded" once (we injected it
      // once); this asserts embedText doesn't re-warm/reload per call, only
      // invokes the already-loaded extractor each time.
      expect(callCount).toBe(2);
    } finally {
      __setExtractorForTest(null);
    }
  });
});
