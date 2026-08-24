"use client";

// The headline screen: one big roll that answers "what do I watch tonight."
// Requests exactly one candidate per roll (`limit: 1`) rather than a batch —
// that keeps this screen's UX honest with what POST /api/recommend actually
// records: every candidate it returns gets a 'shown' interactions row
// (src/lib/ml/feedback.ts's recordShown), so asking for a bigger batch than
// what's actually displayed would silently inflate "shown" data for titles
// the user never saw, which pollutes the exact training signal the phase
// brief calls "load-bearing, not decoration."
import { useCallback, useEffect, useReducer, useRef, useState, type TouchEvent } from "react";
import { postJson } from "@/lib/client/http";
import { useLinkStatus } from "@/lib/client/useLinkStatus";
import { selectDecideViewState } from "@/lib/ui/emptyState";
import { describeActiveFilters, filtersReducer, INITIAL_FILTERS, toApiFilters } from "@/lib/ui/filters";
import type { DecideMode } from "@/lib/ui/modes";
import { DecideEmptyState } from "./DecideEmptyState";
import { FilterBar } from "./FilterBar";
import { ModeSelector } from "./ModeSelector";
import { PosterImage } from "./PosterImage";

interface RecommendedCandidate {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year: number | null;
  runtime: number | null;
  posterPath: string | null;
  score: number;
  why: string[];
}

interface RecommendResponse {
  mode: string;
  candidates: RecommendedCandidate[];
}

const SWIPE_THRESHOLD_PX = 80;

export function DecideScreen({ username }: { username: string }) {
  const [mode, setMode] = useState<DecideMode>("discover");
  const [filters, dispatch] = useReducer(filtersReducer, INITIAL_FILTERS);
  const [candidates, setCandidates] = useState<RecommendedCandidate[] | null>(null);
  const [fetchError, setFetchError] = useState<{ status: number; message: string } | null>(null);
  const [verdict, setVerdict] = useState<"picked" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dragX, setDragX] = useState(0);

  const dragging = useRef(false);
  const startX = useRef(0);
  const dragXRef = useRef(0);

  const { plex, letterboxd, loading: linksLoading, refetch: refetchLinks } = useLinkStatus();

  // No setState call before the first `await`, deliberately: this function
  // is invoked directly from the mode/filter-change effect below, and a
  // synchronous setState call at the top of a function an effect calls
  // synchronously trips React's "avoid setState synchronously in an effect"
  // lint rule. Every state update here happens strictly after the network
  // round-trip resolves — a genuine async continuation, not a synchronous
  // effect-body side effect. One consequence: switching modes/filters keeps
  // showing the previous roll until the new one resolves, rather than
  // flashing a loading state first — a smoother transition, not a bug.
  const roll = useCallback(
    async (opts?: { seed?: number }) => {
      const result = await postJson<RecommendResponse>("/api/recommend", {
        mode,
        filters: toApiFilters(filters),
        limit: 1,
        ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
      });
      setVerdict(null);
      if (!result.ok) {
        setFetchError({ status: result.status, message: result.error ?? "Something went wrong." });
        setCandidates([]);
        return;
      }
      setFetchError(null);
      setCandidates(result.data?.candidates ?? []);
    },
    [mode, filters],
  );

  useEffect(() => {
    // Fetch-on-dependency-change, same shape and same rationale as
    // useLinkStatus.ts's mount effect — see that file's comment.
    // react-hooks/set-state-in-effect flags this even though every setState
    // call inside roll() happens strictly after its `await`, never
    // synchronously as part of this effect's own execution.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    roll();
    // Intentionally re-runs only when mode/filters actually change — `roll`
    // is itself derived from those same two values, so this is equivalent
    // to depending on `roll` directly without an extra render each time the
    // callback identity changes for unrelated reasons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, filters]);

  const candidate = candidates && candidates.length > 0 ? candidates[0] : null;

  const sendFeedback = useCallback(
    (action: "picked" | "skipped" | "snoozed") => {
      if (!candidate) return;
      postJson("/api/recommend/feedback", {
        tmdbId: candidate.tmdbId,
        mediaType: candidate.mediaType,
        action,
        context: { mode, filters: toApiFilters(filters) },
      }).catch(() => {
        // Best-effort — a dropped feedback POST shouldn't block the roll.
      });
    },
    [candidate, mode, filters],
  );

  const handleSkip = useCallback(() => {
    sendFeedback("skipped");
    setDragX(0);
    roll({ seed: Date.now() });
  }, [sendFeedback, roll]);

  const handleSnooze = useCallback(() => {
    sendFeedback("snoozed");
    setDragX(0);
    roll({ seed: Date.now() });
  }, [sendFeedback, roll]);

  const handlePick = useCallback(() => {
    sendFeedback("picked");
    setVerdict("picked");
  }, [sendFeedback]);

  async function handleSync() {
    setSyncing(true);
    await Promise.all([
      plex?.linked ? postJson("/api/plex/sync") : Promise.resolve(),
      letterboxd?.linked ? postJson("/api/letterboxd/sync") : Promise.resolve(),
    ]);
    await refetchLinks();
    setSyncing(false);
    roll({ seed: Date.now() });
  }

  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    dragging.current = true;
    startX.current = e.touches[0]!.clientX;
  }
  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const next = e.touches[0]!.clientX - startX.current;
    dragXRef.current = next;
    setDragX(next);
  }
  function onTouchEnd() {
    if (!dragging.current) return;
    dragging.current = false;
    const finalX = dragXRef.current;
    if (finalX <= -SWIPE_THRESHOLD_PX) {
      handleSkip();
    } else if (finalX >= SWIPE_THRESHOLD_PX) {
      handlePick();
    } else {
      setDragX(0);
    }
  }

  const plexLinked = plex?.linked ?? false;
  const letterboxdLinked = letterboxd?.linked ?? false;
  const plexSyncedAt = plex && plex.linked && plex.connectionCheckedAt ? new Date(plex.connectionCheckedAt) : null;
  const letterboxdSyncedAt =
    letterboxd && letterboxd.linked && letterboxd.lastRunAt ? new Date(letterboxd.lastRunAt) : null;

  const viewState = linksLoading
    ? ({ kind: "loading" } as const)
    : selectDecideViewState({
        plexLinked,
        letterboxdLinked,
        plexSyncedAt,
        letterboxdSyncedAt,
        candidates,
        activeFilterDescriptions: describeActiveFilters(filters),
        fetchError,
      });

  return (
    <main className="flex min-h-screen flex-col">
      <header className="px-4 pt-6">
        <p className="text-sm text-zinc-500">Hey {username}, what to watch tonight?</p>
      </header>

      <ModeSelector mode={mode} onChange={setMode} />
      <FilterBar filters={filters} dispatch={dispatch} />

      {viewState.kind !== "results" ? (
        <DecideEmptyState
          state={viewState}
          onSync={handleSync}
          onClearFilters={() => dispatch({ type: "RESET" })}
          syncing={syncing}
        />
      ) : !candidate ? null : verdict === "picked" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-lg font-semibold">Enjoy {candidate.title}!</p>
          <p className="max-w-xs text-sm text-zinc-500">
            We&apos;ll remember you picked this — it helps future rolls get better.
          </p>
          <button
            onClick={() => roll({ seed: Date.now() })}
            className="tap-target rounded-md border border-zinc-300 px-5 py-2.5 font-medium dark:border-zinc-700"
          >
            Roll for next time
          </button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4">
          <div
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            style={{ transform: `translateX(${dragX}px) rotate(${dragX / 20}deg)` }}
            className="relative w-full max-w-xs touch-pan-y select-none transition-transform"
          >
            <div className="aspect-[2/3] w-full overflow-hidden rounded-xl shadow-lg">
              <PosterImage posterPath={candidate.posterPath} title={candidate.title} className="h-full w-full" />
            </div>
          </div>

          <div className="text-center">
            <h2 className="text-xl font-semibold">
              {candidate.title}{" "}
              {candidate.year ? <span className="font-normal text-zinc-500">({candidate.year})</span> : null}
            </h2>
            {candidate.runtime ? <p className="text-sm text-zinc-500">{candidate.runtime} min</p> : null}
          </div>

          {candidate.why.length > 0 && (
            <ul className="flex flex-wrap justify-center gap-1.5">
              {candidate.why.map((reason) => (
                <li
                  key={reason}
                  className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {reason}
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-zinc-400">Swipe left to skip, right to pick — or use the buttons below.</p>

          <div className="mt-1 flex w-full max-w-xs items-center justify-between gap-2">
            <button
              onClick={handleSkip}
              className="tap-target flex-1 rounded-md border border-zinc-300 py-2.5 text-sm font-medium dark:border-zinc-700"
            >
              Not tonight
            </button>
            <button
              onClick={handleSnooze}
              className="tap-target flex-1 rounded-md border border-zinc-300 py-2.5 text-sm font-medium dark:border-zinc-700"
            >
              Maybe later
            </button>
          </div>
          <button
            onClick={handlePick}
            className="tap-target w-full max-w-xs rounded-md bg-brand py-3 text-base font-semibold text-brand-foreground"
          >
            Watch this
          </button>
          <button
            onClick={() => roll({ seed: Date.now() })}
            className="tap-target text-sm font-medium text-zinc-500 underline"
          >
            Roll again
          </button>
        </div>
      )}
    </main>
  );
}
