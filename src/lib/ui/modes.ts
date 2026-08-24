// Static data for the Decide screen's mode selector — kept out of the
// component so it's one place to add/relabel a mode. Mirrors RecommendMode
// in src/lib/ml/recommend.ts exactly (duplicated as a literal union rather
// than imported: that module transitively pulls in better-sqlite3/db/client,
// which has no business being referenced, even type-only, from client
// bundle code).
export type DecideMode = "discover" | "rewatch" | "continue" | "watchlist" | "binge";

export interface ModeOption {
  value: DecideMode;
  label: string;
  blurb: string;
}

export const DECIDE_MODES: ModeOption[] = [
  { value: "discover", label: "Discover", blurb: "Something new from your library" },
  { value: "rewatch", label: "Rewatch", blurb: "Something you loved before" },
  { value: "continue", label: "Continue", blurb: "Pick up where you left off" },
  { value: "watchlist", label: "Watchlist", blurb: "From your Plex watchlist" },
  { value: "binge", label: "Binge", blurb: "A short binge, not a 9-season slog" },
];

export const QUICK_RUNTIMES: Array<{ label: string; minutes: number | null }> = [
  { label: "Any length", minutes: null },
  { label: "Under 90m", minutes: 90 },
  { label: "Under 2h", minutes: 120 },
];

export const QUICK_DECADES: Array<{ label: string; decade: number | null }> = [
  { label: "Any decade", decade: null },
  { label: "2020s", decade: 2020 },
  { label: "2010s", decade: 2010 },
  { label: "2000s", decade: 2000 },
  { label: "1990s", decade: 1990 },
  { label: "1980s", decade: 1980 },
];

// Real TMDB genre `name` values (src/lib/tmdb/mapper.ts stores genres
// verbatim from TMDB) — a curated subset covering both movie and TV genre
// lists, since score.ts's includeGenres filter does an exact string match
// against whatever's in titles.genres.
export const QUICK_GENRES: string[] = [
  "Action",
  "Comedy",
  "Drama",
  "Thriller",
  "Horror",
  "Science Fiction",
  "Animation",
  "Documentary",
  "Romance",
  "Fantasy",
  "Crime",
  "Mystery",
];
