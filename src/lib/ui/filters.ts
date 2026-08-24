// ---------------------------------------------------------------------------
// Pure filter-state reducer for the Decide screen's quick filters (max
// runtime / decade / genre). Kept framework-free (no React import) so it's
// trivially unit-testable and so DecideScreen.tsx can drive it with either
// useReducer or a hand-rolled dispatch — see src/lib/ui/filters.test.ts.
//
// Deliberately single-select per filter dimension (one runtime cap, one
// decade, one genre) rather than the full multi-select shape ScoreFilters
// supports (src/lib/ml/score.ts allows includeGenres/excludeGenres arrays) —
// "quick filters" on a mobile roll screen are chips you tap, not a form; the
// API shape supports more than the UI chooses to expose.
// ---------------------------------------------------------------------------

export interface DecideFilters {
  maxRuntimeMinutes: number | null;
  decade: number | null;
  genre: string | null;
}

export const INITIAL_FILTERS: DecideFilters = {
  maxRuntimeMinutes: null,
  decade: null,
  genre: null,
};

export type FilterAction =
  | { type: "SET_MAX_RUNTIME"; minutes: number | null }
  | { type: "SET_DECADE"; decade: number | null }
  | { type: "SET_GENRE"; genre: string | null }
  | { type: "RESET" };

export function filtersReducer(state: DecideFilters, action: FilterAction): DecideFilters {
  switch (action.type) {
    case "SET_MAX_RUNTIME":
      // Tapping the already-active runtime chip again clears it (toggle),
      // handled by the caller passing the same value only when actually
      // changing it — this reducer just sets whatever it's told.
      return { ...state, maxRuntimeMinutes: action.minutes };
    case "SET_DECADE":
      return { ...state, decade: action.decade };
    case "SET_GENRE":
      return { ...state, genre: action.genre };
    case "RESET":
      return INITIAL_FILTERS;
    default:
      return state;
  }
}

export function hasActiveFilters(filters: DecideFilters): boolean {
  return filters.maxRuntimeMinutes !== null || filters.decade !== null || filters.genre !== null;
}

/** Number of filter dimensions that differ from INITIAL_FILTERS — drives the
 *  badge on the Filters button (src/components/FilterButton.tsx). A field
 *  explicitly set back to its default (e.g. maxRuntimeMinutes: null after
 *  having been 90) counts as inactive, same as never having been touched —
 *  the count reflects current state, not history. */
export function activeFilterCount(filters: DecideFilters): number {
  let count = 0;
  if (filters.maxRuntimeMinutes !== INITIAL_FILTERS.maxRuntimeMinutes) count++;
  if (filters.decade !== INITIAL_FILTERS.decade) count++;
  if (filters.genre !== INITIAL_FILTERS.genre) count++;
  return count;
}

export interface ApiFilters {
  maxRuntimeMinutes?: number;
  decade?: number;
  includeGenres?: string[];
}

/** Maps UI filter state to the shape src/app/api/recommend/route.ts's
 *  parseFilters() actually reads. Fields are omitted rather than sent as
 *  null — the route only recognizes `number`/`string[]` values for each key
 *  (anything else is silently dropped by its own parsing), so omitting is
 *  the honest representation of "this filter is off". */
export function toApiFilters(filters: DecideFilters): ApiFilters {
  const api: ApiFilters = {};
  if (filters.maxRuntimeMinutes !== null) api.maxRuntimeMinutes = filters.maxRuntimeMinutes;
  if (filters.decade !== null) api.decade = filters.decade;
  if (filters.genre !== null) api.includeGenres = [filters.genre];
  return api;
}

/** Human-readable fragments for each active filter, e.g. ["under 90m",
 *  "1990s", "Comedy"] — used both to label the active-filters row and to
 *  compose the "no candidates matched your filters" empty-state message
 *  (src/lib/ui/emptyState.ts). */
export function describeActiveFilters(filters: DecideFilters): string[] {
  const parts: string[] = [];
  if (filters.maxRuntimeMinutes !== null) parts.push(`under ${filters.maxRuntimeMinutes}m`);
  if (filters.decade !== null) parts.push(`${filters.decade}s`);
  if (filters.genre !== null) parts.push(filters.genre);
  return parts;
}
