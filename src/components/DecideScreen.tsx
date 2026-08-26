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
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StaticChip } from "@/components/ui/Chip";
import { Wordmark } from "@/components/ui/Wordmark";
import { postJson } from "@/lib/client/http";
import { runPlexSync } from "@/lib/client/plexSync";
import { useLinkStatus } from "@/lib/client/useLinkStatus";
import { selectDecideViewState } from "@/lib/ui/emptyState";
import {
  activeFilterCount,
  describeActiveFilters,
  filtersReducer,
  INITIAL_FILTERS,
  toApiFilters,
  type DecideFilters,
} from "@/lib/ui/filters";
import type { DecideMode } from "@/lib/ui/modes";
import { DecideEmptyState } from "./DecideEmptyState";
import { FilterButton } from "./FilterButton";
import { FilterSheet } from "./FilterSheet";
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
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [candidates, setCandidates] = useState<RecommendedCandidate[] | null>(null);
  const [fetchError, setFetchError] = useState<{ status: number; message: string } | null>(null);
  const [verdict, setVerdict] = useState<"picked" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);

  const dragging = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const dragXRef = useRef(0);
  const dragYRef = useRef(0);
  const filterButtonRef = useRef<HTMLButtonElement>(null);

  // Applies the filter sheet's staged draft as the screen's real (committed)
  // filter state, in one go — reusing the existing single-field reducer
  // actions rather than adding a "replace the whole state" action, since
  // React batches these three dispatches into a single re-render anyway.
  const applyFilters = useCallback((next: DecideFilters) => {
    dispatch({ type: "SET_MAX_RUNTIME", minutes: next.maxRuntimeMinutes });
    dispatch({ type: "SET_DECADE", decade: next.decade });
    dispatch({ type: "SET_GENRE", genre: next.genre });
    setFilterSheetOpen(false);
  }, []);

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

  const resetDrag = useCallback(() => {
    setDragX(0);
    setDragY(0);
    dragXRef.current = 0;
    dragYRef.current = 0;
  }, []);

  const handleSkip = useCallback(() => {
    sendFeedback("skipped");
    resetDrag();
    roll({ seed: Date.now() });
  }, [sendFeedback, resetDrag, roll]);

  const handleSnooze = useCallback(() => {
    sendFeedback("snoozed");
    resetDrag();
    roll({ seed: Date.now() });
  }, [sendFeedback, resetDrag, roll]);

  const handlePick = useCallback(() => {
    sendFeedback("picked");
    setVerdict("picked");
  }, [sendFeedback]);

  async function handleSync() {
    setSyncing(true);
    // Plex sync is a background job now (src/lib/plex/syncJob.ts) — POST
    // /api/plex/sync returns immediately, so runPlexSync() polls status
    // until it settles. Awaited here (rather than fire-and-forget) because
    // this screen's whole point is rolling fresh candidates right after —
    // rolling before the sync actually finished would just show stale data.
    await Promise.all([
      plex?.linked ? runPlexSync() : Promise.resolve(),
      letterboxd?.linked ? postJson("/api/letterboxd/sync") : Promise.resolve(),
    ]);
    await refetchLinks();
    setSyncing(false);
    roll({ seed: Date.now() });
  }

  // Three-way swipe, which is the entire verdict UI on a phone (the buttons
  // below are visually hidden there — see the sr-only note on that row).
  //   left  → Not tonight   (skip)
  //   right → Maybe later   (snooze)
  //   up    → Watch this    (pick)
  // A drag is committed to whichever axis it travelled furthest on, so a
  // sloppy diagonal resolves to one verdict rather than firing two or
  // neither. Downward drags are deliberately inert: there is no fourth
  // verdict, and on a phone a downward gesture over content usually means
  // "scroll" or "pull to refresh", so swallowing it would be rude.
  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    dragging.current = true;
    startX.current = e.touches[0]!.clientX;
    startY.current = e.touches[0]!.clientY;
  }
  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const nextX = e.touches[0]!.clientX - startX.current;
    const nextY = e.touches[0]!.clientY - startY.current;
    dragXRef.current = nextX;
    dragYRef.current = nextY;
    setDragX(nextX);
    setDragY(nextY);
  }
  function onTouchEnd() {
    if (!dragging.current) return;
    dragging.current = false;
    const finalX = dragXRef.current;
    const finalY = dragYRef.current;
    const verticalWins = Math.abs(finalY) > Math.abs(finalX);

    if (verticalWins) {
      if (finalY <= -SWIPE_THRESHOLD_PX) {
        handlePick();
        return;
      }
    } else if (finalX <= -SWIPE_THRESHOLD_PX) {
      handleSkip();
      return;
    } else if (finalX >= SWIPE_THRESHOLD_PX) {
      handleSnooze();
      return;
    }
    resetDrag();
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

  // Which verdict the current drag is heading for, and how far along it is
  // (0..1). Purely derived from dragX/dragY — no extra state, no extra
  // handler — and drives nothing but the opacity of the three labels over
  // the poster. onTouchEnd re-derives the same decision independently, so
  // these can never disagree about what a release would do.
  const verticalDrag = Math.abs(dragY) > Math.abs(dragX);
  const dragAxis = verticalDrag ? dragY : dragX;
  const dragProgress = Math.min(1, Math.abs(dragAxis) / SWIPE_THRESHOLD_PX);
  const skipOpacity = !verticalDrag && dragX < 0 ? dragProgress : 0;
  const snoozeOpacity = !verticalDrag && dragX > 0 ? dragProgress : 0;
  const pickOpacity = verticalDrag && dragY < 0 ? dragProgress : 0;

  return (
    // The aurora is a SIBLING of <main>, not a child, and that is load-bearing:
    // animate-content-in applies a CSS transform, and a transformed ancestor
    // becomes the containing block for its `position: fixed` descendants — the
    // same spec rule that forced FilterSheet to portal out to document.body.
    // Nested here, the wash would pin itself to a <main> that grows taller
    // than the viewport and scroll away with the content.
    <>
      <div className="aurora" aria-hidden="true" />
      {/* Fixed to the viewport minus the nav on a phone, with overflow
          clipped: this screen is a single static surface you swipe on, not a
          document you scroll. Desktop keeps the ordinary growing page. */}
      <main className="flex h-app-screen flex-col overflow-hidden animate-content-in sm:h-auto sm:min-h-screen-dvh sm:overflow-visible">
      <header className="flex shrink-0 items-start justify-between gap-3 px-4 pt-4 sm:pt-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary">Tonight</p>
          <p className="mt-0.5 truncate font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">
            Hey {username}, what to watch tonight?
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          <Wordmark size="sm" />
        </div>
      </header>

      {/* Mode and filters share one row — see ModeSelector for why the pill
          strip becomes a native select at this width. */}
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
        <ModeSelector mode={mode} onChange={setMode} />
        <FilterButton
          ref={filterButtonRef}
          activeCount={activeFilterCount(filters)}
          onClick={() => setFilterSheetOpen(true)}
        />
      </div>
      <FilterSheet
        open={filterSheetOpen}
        committedFilters={filters}
        onApply={applyFilters}
        onClose={() => setFilterSheetOpen(false)}
        returnFocusRef={filterButtonRef}
      />

      {viewState.kind !== "results" ? (
        <DecideEmptyState
          state={viewState}
          onSync={handleSync}
          onClearFilters={() => dispatch({ type: "RESET" })}
          syncing={syncing}
        />
      ) : !candidate ? null : verdict === "picked" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-6 text-center">
          <p className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">
            Enjoy {candidate.title}!
          </p>
          <p className="max-w-xs text-[13px] text-secondary">
            We&apos;ll remember you picked this — it helps future rolls get better.
          </p>
          <Button onClick={() => roll({ seed: Date.now() })} variant="secondary">
            Roll for next time
          </Button>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 pb-2">
          {/* The poster takes whatever vertical space is left and no more —
              that's what keeps this screen inside one viewport on a phone.
              Height drives the box (max 450px = 300px wide at 2:3), so the
              artwork shrinks on a short screen instead of pushing the title
              and the swipe hint off the bottom. */}
          <div className="flex min-h-0 w-full flex-1 items-center justify-center">
            <div
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              style={{ transform: `translate(${dragX}px, ${dragY}px) rotate(${dragX / 20}deg)` }}
              className="relative aspect-[2/3] h-full max-h-[450px] max-w-[300px] touch-pan-y select-none transition-transform"
            >
              <div
                // Inset hairline so the artwork has a defined edge against the
                // void — posters are frequently near-black at their borders.
                style={{ boxShadow: "inset 0 0 0 1px var(--hairline-inset)" }}
                className="h-full w-full overflow-hidden rounded-[16px]"
              >
                <PosterImage posterPath={candidate.posterPath} title={candidate.title} className="h-full w-full" />
              </div>

              {/* Swipe verdict labels. Presentation only — they read the drag
                  offsets and never write them, and onTouchEnd re-derives the
                  same decision independently against SWIPE_THRESHOLD_PX. */}
              <span
                aria-hidden="true"
                style={{ opacity: skipOpacity }}
                className="pointer-events-none absolute left-3 top-3 rounded-full bg-[color:var(--negative-soft)] px-2.5 py-1 text-[11px] font-semibold text-negative"
              >
                Not tonight
              </span>
              <span
                aria-hidden="true"
                style={{ opacity: snoozeOpacity }}
                className="pointer-events-none absolute right-3 top-3 rounded-full bg-elevated px-2.5 py-1 text-[11px] font-semibold text-secondary"
              >
                Maybe later
              </span>
              {/* Coral, matching the "Watch this" button below: same single
                  action, two presentations, never both on screen at once —
                  so the one-coral-element rule still holds. */}
              <span
                aria-hidden="true"
                style={{ opacity: pickOpacity }}
                className="pointer-events-none absolute inset-x-3 top-3 rounded-full bg-[color:var(--glow-soft)] px-2.5 py-1 text-center text-[11px] font-semibold text-glow"
              >
                Watch this
              </span>
            </div>
          </div>

          <div className="shrink-0 text-center">
            <h2 className="font-display text-[22px] font-bold leading-tight tracking-[-0.02em] text-heading sm:text-[28px]">
              {candidate.title}{" "}
              {candidate.year ? (
                <span className="font-mono text-[16px] font-normal tabular-nums text-secondary sm:text-[18px]">
                  ({candidate.year})
                </span>
              ) : null}
            </h2>
            {candidate.runtime ? (
              <p className="mt-1 font-mono text-xs tabular-nums text-muted">{candidate.runtime} min</p>
            ) : null}
          </div>

          {candidate.why.length > 0 && (
            <ul className="flex shrink-0 flex-wrap justify-center gap-1.5">
              {candidate.why.map((reason) => (
                <StaticChip key={reason}>{reason}</StaticChip>
              ))}
            </ul>
          )}

          {/* px-12 keeps this clear of the Roll again button pinned to the
              bottom-left corner below — they sit at the same height. */}
          <p className="shrink-0 px-12 text-center text-[11px] text-muted">
            Swipe left to pass, right for later, up to watch.
          </p>

          {/* Visually hidden on a phone, where the swipe gestures above are
              the interface — but still in the DOM and still focusable, so
              keyboard and screen-reader users keep every verdict. A gesture
              is not an accessible control; deleting these outright would
              have made the screen unusable without a touchscreen.
              `focus:not-sr-only` also brings them back on screen the moment
              someone tabs to one, so they can be seen as well as heard. */}
          <div className="sr-only flex w-full max-w-[300px] shrink-0 flex-col gap-2 focus-within:not-sr-only sm:not-sr-only sm:flex">
            <div className="flex items-center justify-between gap-2">
              <Button onClick={handleSkip} variant="secondary" className="flex-1">
                Not tonight
              </Button>
              <Button onClick={handleSnooze} variant="secondary" className="flex-1">
                Maybe later
              </Button>
            </div>
            {/* The one coral control in the entire app. Nothing else may use
                the glow variant — see Button.tsx. */}
            <Button onClick={handlePick} variant="glow" size="lg" className="w-full">
              Watch this
            </Button>
          </div>

          {/* Roll again: an escape hatch for "I don't want to judge this
              one." Deliberately small and out of the way in the bottom-left
              corner — it must stay reachable without ever competing with the
              three verdicts, since using it records no signal at all. */}
          <button
            type="button"
            onClick={() => roll({ seed: Date.now() })}
            aria-label="Roll again"
            className="tap-target absolute bottom-0 left-0 flex h-[44px] w-[44px] items-center justify-center rounded-full text-muted transition-colors duration-[180ms] ease-out hover:bg-hover hover:text-accent active:translate-y-px"
          >
            <RotateCw className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}
      </main>
    </>
  );
}
