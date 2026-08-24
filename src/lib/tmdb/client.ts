// ---------------------------------------------------------------------------
// Low-level TMDB v3 API client. Pure network layer — no DB access here (see
// store.ts for the write side) — so it can be exercised in tests with mocked
// `fetch` and no live key.
//
// The user's .env.local currently holds a dummy TMDB_API_KEY. TMDB responds
// to a bad key with 401 + a JSON body, not a network failure, so we
// specifically detect that and raise TmdbAuthError with instructions rather
// than letting a confusing 401 propagate.
// ---------------------------------------------------------------------------

import { env } from "@/lib/env";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const MAX_RETRIES = 3;

export class TmdbAuthError extends Error {
  constructor() {
    super(
      "TMDB rejected the configured API key (HTTP 401). Get a free key at " +
        "https://www.themoviedb.org/settings/api, then set TMDB_API_KEY in .env.local " +
        "(or the deployment environment) and restart the app.",
    );
    this.name = "TmdbAuthError";
  }
}

export class TmdbNotFoundError extends Error {
  constructor(tmdbId: number, mediaType: string) {
    super(`TMDB has no ${mediaType} with id ${tmdbId}.`);
    this.name = "TmdbNotFoundError";
  }
}

export class TmdbRequestError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`TMDB request to ${path} failed with HTTP ${status}.`);
    this.name = "TmdbRequestError";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET against the TMDB v3 API with `api_key` as a query param. Retries
 *  politely on 429, honoring `Retry-After` when present and backing off
 *  exponentially otherwise, up to MAX_RETRIES. */
export async function tmdbGet<T>(path: string, searchParams: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  url.searchParams.set("api_key", env.TMDB_API_KEY);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) throw new TmdbRequestError(429, path);
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** attempt;
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status === 401) throw new TmdbAuthError();
    if (!response.ok) throw new TmdbRequestError(response.status, path);

    return (await response.json()) as T;
  }

  // Unreachable — the loop always either returns or throws — but keeps TS
  // happy about a guaranteed return value.
  throw new TmdbRequestError(429, path);
}

export interface TmdbCastMember {
  name: string;
  order: number;
}

export interface TmdbCrewMember {
  name: string;
  job: string;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbDetailsResponse {
  id: number;
  // movie-only
  title?: string;
  release_date?: string;
  runtime?: number;
  // tv-only
  name?: string;
  first_air_date?: string;
  episode_run_time?: number[];
  // shared
  overview?: string | null;
  poster_path?: string | null;
  genres?: TmdbGenre[];
  credits?: {
    cast?: TmdbCastMember[];
    crew?: TmdbCrewMember[];
  };
  // Fetched via append_to_response at no extra request cost. mapper.ts reads
  // whichever of these two shapes is present — movie responses nest under
  // "keywords", tv responses under "results" — into titles.keywords.
  keywords?: {
    keywords?: TmdbGenre[]; // movie shape
    results?: TmdbGenre[]; // tv shape
  };
}

export type TmdbMediaType = "movie" | "tv";

/** Fetches full details for one title, including credits and keywords in a
 *  single request via `append_to_response`. Translates a 404 into
 *  TmdbNotFoundError with the id/mediaType that's actually useful to log. */
export async function fetchTmdbDetails(
  tmdbId: number,
  mediaType: TmdbMediaType,
): Promise<TmdbDetailsResponse> {
  try {
    return await tmdbGet<TmdbDetailsResponse>(`/${mediaType}/${tmdbId}`, {
      append_to_response: "credits,keywords",
    });
  } catch (err) {
    if (err instanceof TmdbRequestError && err.status === 404) {
      throw new TmdbNotFoundError(tmdbId, mediaType);
    }
    throw err;
  }
}
