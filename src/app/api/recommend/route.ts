// POST /api/recommend — mode + filters in, ranked candidates out. Every
// candidate returned writes an `interactions` row with action='shown'
// (feedback.ts's recordShown) — the only source of training data for
// cf.ts/ltr.ts (see the master plan). Synchronous end-to-end under the hood
// (recommend.ts, like the rest of this codebase's better-sqlite3 usage,
// makes no async DB calls) — this handler stays `async` only because
// requireUser()/request.json() are.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { recordShown } from "@/lib/ml/feedback";
import { recommend, type RecommendMode, type RecommendOptions } from "@/lib/ml/recommend";
import type { ScoreFilters } from "@/lib/ml/score";
import { lazilyEnrichStubCandidates } from "@/lib/tmdb/lazyEnrich";

const VALID_MODES: RecommendMode[] = ["rewatch", "watchlist", "discover", "continue", "binge"];

function parseFilters(raw: unknown): ScoreFilters | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const filters: ScoreFilters = {};
  if (typeof r.maxRuntimeMinutes === "number") filters.maxRuntimeMinutes = r.maxRuntimeMinutes;
  if (typeof r.decade === "number") filters.decade = r.decade;
  if (Array.isArray(r.includeGenres)) filters.includeGenres = r.includeGenres.filter((g): g is string => typeof g === "string");
  if (Array.isArray(r.excludeGenres)) filters.excludeGenres = r.excludeGenres.filter((g): g is string => typeof g === "string");
  if (typeof r.minMonthsSinceWatched === "number") filters.minMonthsSinceWatched = r.minMonthsSinceWatched;
  return filters;
}

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { mode, filters, seed, limit } = (body ?? {}) as Record<string, unknown>;
  if (typeof mode !== "string" || !VALID_MODES.includes(mode as RecommendMode)) {
    return NextResponse.json({ error: `mode must be one of ${VALID_MODES.join(", ")}.` }, { status: 400 });
  }

  const options: RecommendOptions = {
    mode: mode as RecommendMode,
    filters: parseFilters(filters),
    seed: typeof seed === "number" ? seed : undefined,
    limit: typeof limit === "number" && limit > 0 ? Math.min(limit, 50) : undefined,
  };

  let candidates;
  try {
    candidates = recommend(user.id, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "Failed to generate recommendations.", detail: message }, { status: 500 });
  }

  try {
    // Enrich any still-stub candidates about to be surfaced (bounded — see
    // lazyEnrich.ts). Best-effort: a TMDB failure/rate-limit here must never
    // turn a successful recommendation into a 500, so this degrades to
    // returning the un-enriched stub data rather than throwing.
    candidates = await lazilyEnrichStubCandidates(candidates);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[api/recommend] lazy enrichment failed", err);
  }

  try {
    recordShown(user.id, candidates, { mode: options.mode, filters: options.filters, seed: options.seed });
  } catch (err) {
    // Best-effort per the file header — never let a logging failure turn a
    // successful recommendation into a 500.
    // eslint-disable-next-line no-console
    console.error("[api/recommend] failed to record shown interactions", err);
  }

  return NextResponse.json({ mode: options.mode, candidates });
}
