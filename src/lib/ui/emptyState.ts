// ---------------------------------------------------------------------------
// Pure selection logic for which empty/error state the Decide screen should
// render. Kept separate from DecideScreen.tsx so every branch (brand-new
// account, linked-but-unsynced, synced-but-filtered-to-nothing, Plex 502,
// expired session, generic 500) is unit-testable as a plain function of
// inputs, per the phase brief's "treat as first-class" empty/error states.
//
// Precedence, most to least specific, matches how a user should actually be
// guided: a request-level error always wins (it's the most concrete thing
// that happened), then "you haven't linked anything", then "you linked but
// never synced" (before we even bother saying "nothing matched" — an unsynced
// account legitimately has zero candidates and "no candidates" would be a
// misleading, unhelpful message for it), then genuinely-filtered-to-empty.
// ---------------------------------------------------------------------------

export interface FetchFailure {
  status: number;
  message: string;
}

export interface DecideViewInput {
  plexLinked: boolean;
  letterboxdLinked: boolean;
  /** sync_state.last_run_at for the source, or null if it has never
   *  completed a sync (never attempted, or every attempt failed before
   *  recording success — see src/app/api/plex/sync's recordSyncState, which
   *  writes last_run_at on both success and failure, so "null" here
   *  specifically means "never even tried yet", not "tried and failed";
   *  failures are covered by fetchError instead when they're the reason
   *  candidates is empty). */
  plexSyncedAt: Date | null;
  letterboxdSyncedAt: Date | null;
  /** null = request in flight / not yet made. [] = request succeeded with
   *  zero candidates. */
  candidates: unknown[] | null;
  activeFilterDescriptions: string[];
  fetchError: FetchFailure | null;
}

export type DecideViewState =
  | { kind: "loading" }
  | { kind: "no-links" }
  | { kind: "not-synced"; sources: Array<"plex" | "letterboxd"> }
  | { kind: "plex-unreachable"; message: string }
  | { kind: "session-expired" }
  | { kind: "server-error"; message: string }
  | { kind: "no-candidates"; activeFilters: string[] }
  | { kind: "results" };

export function selectDecideViewState(input: DecideViewInput): DecideViewState {
  if (input.fetchError) {
    if (input.fetchError.status === 401) return { kind: "session-expired" };
    if (input.fetchError.status === 502) return { kind: "plex-unreachable", message: input.fetchError.message };
    return { kind: "server-error", message: input.fetchError.message };
  }

  if (!input.plexLinked && !input.letterboxdLinked) return { kind: "no-links" };

  const unsyncedSources: Array<"plex" | "letterboxd"> = [];
  if (input.plexLinked && !input.plexSyncedAt) unsyncedSources.push("plex");
  if (input.letterboxdLinked && !input.letterboxdSyncedAt) unsyncedSources.push("letterboxd");

  if (input.candidates === null) return { kind: "loading" };

  if (input.candidates.length === 0) {
    if (unsyncedSources.length > 0) return { kind: "not-synced", sources: unsyncedSources };
    return { kind: "no-candidates", activeFilters: input.activeFilterDescriptions };
  }

  return { kind: "results" };
}
