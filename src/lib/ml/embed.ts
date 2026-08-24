// ---------------------------------------------------------------------------
// Content embeddings — transformers.js v3 (`@huggingface/transformers`, Node
// backend) running a quantized `all-MiniLM-L6-v2` feature-extraction
// pipeline. This is the ONLY place ML inference touches a real model in this
// codebase; everything downstream (score.ts's cosine similarity, cf.ts,
// ltr.ts) works on plain numbers.
//
// CONSTRAINT 22 (master plan): onnxruntime-node — which
// `@huggingface/transformers` uses as its Node execution provider — is
// inference-only. There is no training API here and none is sought; this
// file only ever runs the pretrained MiniLM forward pass.
//
// MODEL ARTIFACT / DOCKER (see the Phase 5 report for exact numbers): the
// container must not download model weights at runtime on a home NAS with
// unpredictable connectivity, so the model is loaded from a LOCAL directory,
// never the network, once NODE_ENV=production. That directory is
// `resolveModelDir()` below — defaulting to <cwd>/models, overridable via
// ML_MODEL_DIR — and Phase 6 is responsible for baking
// `<modelDir>/Xenova/all-MiniLM-L6-v2/{config.json,tokenizer.json,
// tokenizer_config.json,onnx/model_quantized.onnx}` into the image at that
// path. Outside production (dev), a missing local copy is allowed to fall
// back to downloading from the hub so `npm run dev` works without a manual
// vendoring step.
//
// WARM ONCE: warmEmbeddingModel() memoizes the in-flight/loaded pipeline in
// a module-level singleton. Every caller — the recommend route, the batch
// backfill — awaits the same promise, so the (multi-second) model load only
// ever happens once per process, not once per request.
// ---------------------------------------------------------------------------

import path from "node:path";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

/** Directory transformers.js treats as its local model root. It expects to
 *  find `<dir>/<MODEL_ID>/...` beneath it. Configurable via ML_MODEL_DIR so
 *  Phase 6 can bake the model in at whatever path suits the image (e.g.
 *  `/app/models`) without this module needing to change. */
export function resolveModelDir(): string {
  return process.env.ML_MODEL_DIR ?? path.join(process.cwd(), "models");
}

// ---------------------------------------------------------------------------
// Embedding text construction — pure, no DB, no network.
// ---------------------------------------------------------------------------

export interface EmbeddingSourceTitle {
  genres?: string[] | null;
  directors?: string[] | null;
  cast?: string[] | null;
  keywords?: string[] | null;
  overview?: string | null;
}

/** Builds the text fed to the embedding model, in the fixed field order the
 *  plan specifies: genres + directors + cast + keywords + overview. Missing
 *  arrays/overview are treated as empty, never thrown on. */
/** Shared JSON-text-array parser for titles.genres/directors/cast/keywords —
 *  used by embedBackfill.ts, ltr.ts, and recommend.ts, all of which read
 *  these columns back out. Defensive: malformed JSON or a non-array value
 *  parses to [] rather than throwing, since a corrupt column should degrade
 *  a single title's signal, not crash the whole request. */
export function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function buildEmbeddingText(title: EmbeddingSourceTitle): string {
  const parts = [
    ...(title.genres ?? []),
    ...(title.directors ?? []),
    ...(title.cast ?? []),
    ...(title.keywords ?? []),
    title.overview ?? "",
  ].filter((p) => typeof p === "string" && p.trim() !== "");
  return parts.join(". ").trim();
}

// ---------------------------------------------------------------------------
// Vector math — pure.
// ---------------------------------------------------------------------------

export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec.slice();
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Plain dot product. Valid AS cosine similarity only when both inputs are
 *  already L2-normalized — which is the invariant every vector this module
 *  produces or stores maintains, per the plan ("mean-pool + L2-normalize so
 *  cosine similarity is a plain dot product"). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

// ---------------------------------------------------------------------------
// BLOB encode/decode — shared format with titles.embedding AND cf.ts's
// cf_item_factors/cf_user_factors columns (same "raw Float32Array bytes"
// rationale from schema.ts's file header applies to both).
// ---------------------------------------------------------------------------

export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Decodes a BLOB column back into a Float32Array. Always copies first: a
 *  Buffer read back from better-sqlite3 is not guaranteed to start at a
 *  4-byte-aligned offset within its underlying ArrayBuffer, which
 *  Float32Array's constructor requires — `Buffer.from(buf)` always produces
 *  a copy with byteOffset 0. */
export function decodeVector(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Model singleton + inference.
// ---------------------------------------------------------------------------

export type Extractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

/** Test-only hook: injects a fake extractor so embed.test.ts (and any other
 *  test that needs embedText()) never imports the real
 *  `@huggingface/transformers` package or touches the network/CPU-heavy
 *  ONNX runtime. Pass null to reset to "unloaded" (forces the next
 *  warmEmbeddingModel() call to go through loadExtractor() again). */
export function __setExtractorForTest(fn: Extractor | null): void {
  extractorPromise = fn ? Promise.resolve(fn) : null;
}

async function loadExtractor(): Promise<Extractor> {
  const { pipeline, env: transformersEnv } = await import("@huggingface/transformers");

  const modelDir = resolveModelDir();
  // Production/Docker: never phone home — the NAS may have no or
  // unpredictable connectivity. A missing local model must fail loudly at
  // warm-up, not silently try the network and hang/error minutes later.
  const allowRemote = process.env.NODE_ENV !== "production";
  transformersEnv.localModelPath = modelDir;
  transformersEnv.allowLocalModels = true;
  transformersEnv.allowRemoteModels = allowRemote;

  const pipe = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
  return async (text, options) => {
    const output = await pipe(text, options);
    return { data: output.data as Float32Array };
  };
}

/** Warms the model once and memoizes the loaded pipeline for the life of the
 *  process. Safe to call concurrently — memoizes the in-flight promise, not
 *  just the eventual result, so N simultaneous first-callers still only
 *  trigger one load. Call this eagerly at boot if you want the first request
 *  to be fast; otherwise the first embedText() call pays the (multi-second)
 *  load cost and every call after it is warm. */
export function warmEmbeddingModel(): Promise<Extractor> {
  if (!extractorPromise) extractorPromise = loadExtractor();
  return extractorPromise;
}

/** Embeds one string into a mean-pooled, L2-normalized EMBEDDING_DIMS-dim
 *  vector. */
export async function embedText(text: string): Promise<Float32Array> {
  const extractor = await warmEmbeddingModel();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
  // Belt-and-suspenders re-normalization: `normalize: true` above already
  // does this inside the pipeline, but doing it again here is cheap and
  // guarantees the stored-vector invariant even if a future model/library
  // swap silently drops that option.
  return l2Normalize(data);
}
