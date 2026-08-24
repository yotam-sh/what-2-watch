// ---------------------------------------------------------------------------
// Maps a raw TMDB details response into the shape `titles` actually stores.
// Pure function — no DB, no network — so it's fully unit-testable against
// fixture JSON without a live key.
// ---------------------------------------------------------------------------

import type { TmdbDetailsResponse, TmdbMediaType } from "./client";

export interface MappedTitle {
  title: string;
  year: number | null;
  runtime: number | null;
  genres: string[];
  directors: string[];
  cast: string[];
  keywords: string[];
  overview: string | null;
  posterPath: string | null;
}

// Top-billed cast only — matches what a taste/embedding model in Phase 5
// actually needs; TMDB's full cast list can run to hundreds of entries.
const MAX_CAST = 10;

export function mapTmdbDetails(details: TmdbDetailsResponse, mediaType: TmdbMediaType): MappedTitle {
  const rawTitle = mediaType === "movie" ? details.title : details.name;
  const dateStr = mediaType === "movie" ? details.release_date : details.first_air_date;
  const yearNum = dateStr ? Number(dateStr.slice(0, 4)) : NaN;
  const runtime =
    mediaType === "movie" ? details.runtime ?? null : details.episode_run_time?.[0] ?? null;

  const genres = (details.genres ?? []).map((g) => g.name);

  const directors = (details.credits?.crew ?? [])
    .filter((member) => member.job === "Director")
    .map((member) => member.name);

  const cast = (details.credits?.cast ?? [])
    .slice() // don't mutate the response
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_CAST)
    .map((member) => member.name);

  // Movie and TV responses shape this differently ("keywords" vs "results")
  // — see TmdbDetailsResponse in client.ts. Neither key is ever present
  // together, so trying "keywords" first and falling back to "results" is
  // unambiguous regardless of media type.
  const keywords = (details.keywords?.keywords ?? details.keywords?.results ?? []).map(
    (k) => k.name,
  );

  return {
    title: rawTitle && rawTitle.trim() !== "" ? rawTitle : `Unknown (${details.id})`,
    year: Number.isFinite(yearNum) ? yearNum : null,
    runtime,
    genres,
    directors,
    cast,
    keywords,
    overview: details.overview ?? null,
    posterPath: details.poster_path ?? null,
  };
}
