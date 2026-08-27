// ---------------------------------------------------------------------------
// Did a 'picked' interaction actually turn into a watch?
//
// THE PROBLEM. Swiping up records `picked` the instant a user chooses,
// before a single frame plays. It captures the *intention* to watch, not the
// watching. Someone who starts a film and bails after ten minutes leaves an
// identical row to someone who loved it.
//
// WHY THIS CAN'T BE DECIDED AT THE TIME. Abandonment is not an event, it's
// an absence — and absences are only observable in hindsight. At the moment
// someone stops twenty minutes in, nothing in the world distinguishes "gave
// up" from "kids woke up, will finish on Thursday". The information does not
// exist yet. So the label is DERIVED here, lazily, from Plex's current state
// whenever training runs, and it is free to change: a resume three days
// later simply re-resolves the same pick differently. Nothing is ever
// written down as a verdict.
//
// WHY ABANDONMENT IS NOT A NEGATIVE. It resolves to *no data*, never to
// label 0. The ranker already has honest negatives — `skipped` and `snoozed`
// are explicit statements from someone looking straight at the title.
// "Stopped watching" conflates dislike with falling asleep, a phone call,
// finishing it on Netflix, or watching it on a device this server never
// sees. A false negative teaches the model you dislike something you loved,
// which is strictly worse than having no row at all. Better twelve honest
// positives than thirty labels where a third are lies — the same instinct
// that gates CF and LTR off entirely until there's enough real signal.
//
// NO DATABASE IMPORT HERE, deliberately. Same split as library.ts (pure,
// unit-tested) versus librarySync.ts (DB writes): these thresholds and grace
// periods are precisely the logic worth testing, and a module-scope db import
// would drag a live SQLCipher connection into every test that touches them.
// The DB read lives in ltr.ts, its only caller.
// ---------------------------------------------------------------------------

/** Fraction of runtime that counts as "watched it". Plex's own default
 *  watched threshold is 90%; matching it keeps this consistent with what
 *  viewCount does on the server. */
export const COMPLETION_FRACTION = 0.9;

/** How long a stalled pick waits before it stops being "maybe still
 *  watching". Deliberately generous — picking a film back up three weeks
 *  later is completely ordinary, and the cost of being impatient is a
 *  wrongly-excluded positive. */
export const RESUME_GRACE_DAYS = 21;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PickBaselineShape {
  viewCountAtPick?: number;
  viewOffsetAtPick?: number;
  durationAtPick?: number | null;
}

export type PickOutcome =
  /** Confirmed watch — train on it. */
  | { kind: "watched"; reason: string }
  /** Still in play, or too soon to tell. Exclude and ask again next run. */
  | { kind: "unresolved"; reason: string }
  /** Stalled past the grace period, or never started. Exclude — NOT a
   *  negative. */
  | { kind: "abandoned"; reason: string };

/** Reads the baseline a pick stored in its own context_json. Returns null
 *  for picks written before baselines existed, and for Letterboxd-only
 *  titles that have no Plex row to measure against. */
export function readBaseline(contextJson: string | null): PickBaselineShape | null {
  if (!contextJson) return null;
  try {
    const parsed = JSON.parse(contextJson) as { baseline?: PickBaselineShape | null };
    return parsed.baseline ?? null;
  } catch {
    return null;
  }
}

/** The Plex state a decision is made against. Passed in rather than queried
 *  so the rules below stay pure and unit-testable — same split as
 *  library.ts (pure) vs librarySync.ts (DB), for the same reason: these
 *  thresholds and grace periods are exactly the kind of logic that is worth
 *  testing and impossible to test through a live server. */
export interface PlexPlaybackState {
  viewCount: number;
  viewOffset: number;
  duration: number | null;
  lastViewedAt: Date | null;
}

/** Pure rules. `state` null means the title has no Plex row at all. */
export function classifyPickOutcome(params: {
  pickedAt: Date;
  baseline: PickBaselineShape | null;
  state: PlexPlaybackState | null;
  now: Date;
}): PickOutcome {
  const { now, state } = params;

  // Not on Plex at all. They may well have watched it somewhere this app
  // cannot see, so this is an unknown, not a rejection.
  if (!state) return { kind: "abandoned", reason: "no Plex row for this title" };

  // Picks recorded before baselines were captured can't be compared against
  // anything. Excluded rather than guessed at — this drains away on its own
  // as new picks accumulate.
  if (!params.baseline || params.baseline.viewCountAtPick === undefined) {
    return { kind: "unresolved", reason: "pick predates baseline capture" };
  }

  const viewCount = state.viewCount;
  const viewOffset = state.viewOffset;
  const lastViewedAt = state.lastViewedAt;
  const baseCount = params.baseline.viewCountAtPick ?? 0;
  const baseOffset = params.baseline.viewOffsetAtPick ?? 0;

  // 1. viewCount went up. Plex only increments that at its own completion
  //    threshold, so this is a finished watch — including a completed
  //    rewatch, which is why the comparison is against the baseline rather
  //    than against zero.
  if (viewCount > baseCount) {
    return { kind: "watched", reason: `viewCount ${baseCount} -> ${viewCount}` };
  }

  // 2. Got far enough in to count, even if Plex hasn't ticked over yet
  //    (stopping during the credits is a watch by any human measure).
  const duration = state.duration ?? params.baseline.durationAtPick ?? null;
  if (duration && duration > 0) {
    const fraction = viewOffset / duration;
    if (fraction >= COMPLETION_FRACTION) {
      return { kind: "watched", reason: `${Math.round(fraction * 100)}% watched` };
    }
  }

  // 3. Still moving? Progress since the pick means they're engaged with it,
  //    and the outcome genuinely isn't known yet.
  const progressed = viewOffset > baseOffset;
  const daysSinceLastPlay =
    lastViewedAt !== null ? (now.getTime() - lastViewedAt.getTime()) / MS_PER_DAY : null;
  const playedSincePick = lastViewedAt !== null && lastViewedAt.getTime() >= params.pickedAt.getTime();

  if (progressed || playedSincePick) {
    if (daysSinceLastPlay !== null && daysSinceLastPlay <= RESUME_GRACE_DAYS) {
      return {
        kind: "unresolved",
        reason: `in progress, last played ${Math.round(daysSinceLastPlay)}d ago`,
      };
    }
    // Started, made some progress, then went quiet for longer than anyone
    // reasonably pauses. Still not a negative — see the file header.
    return { kind: "abandoned", reason: `stalled ${Math.round(daysSinceLastPlay ?? 0)}d with no progress` };
  }

  // 4. Never started. Within the grace period they may simply not have got
  //    round to it yet.
  const daysSincePick = (now.getTime() - params.pickedAt.getTime()) / MS_PER_DAY;
  if (daysSincePick <= RESUME_GRACE_DAYS) {
    return { kind: "unresolved", reason: `picked ${Math.round(daysSincePick)}d ago, not started` };
  }
  return { kind: "abandoned", reason: "never started" };
}
