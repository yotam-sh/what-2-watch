import { describe, expect, it } from "vitest";
import {
  classifyPickOutcome,
  COMPLETION_FRACTION,
  readBaseline,
  RESUME_GRACE_DAYS,
  type PickBaselineShape,
  type PlexPlaybackState,
} from "./pickOutcome";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RUNTIME = 120 * 60 * 1000; // a 2-hour film in ms

const PICKED_AT = new Date("2026-08-01T20:00:00Z");
function daysAfterPick(n: number): Date {
  return new Date(PICKED_AT.getTime() + n * MS_PER_DAY);
}

function baseline(over: Partial<PickBaselineShape> = {}): PickBaselineShape {
  return { viewCountAtPick: 0, viewOffsetAtPick: 0, durationAtPick: RUNTIME, ...over };
}
function state(over: Partial<PlexPlaybackState> = {}): PlexPlaybackState {
  return { viewCount: 0, viewOffset: 0, duration: RUNTIME, lastViewedAt: null, ...over };
}

describe("classifyPickOutcome — confirmed watches", () => {
  it("counts a viewCount increment as watched", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: state({ viewCount: 1, lastViewedAt: daysAfterPick(0.1) }),
      now: daysAfterPick(1),
    });
    expect(out.kind).toBe("watched");
  });

  it("counts a completed REWATCH — the comparison is against the baseline, not zero", () => {
    // Already watched twice before the pick. Without a baseline this would be
    // indistinguishable from "it was already 3 a year ago".
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline({ viewCountAtPick: 2 }),
      state: state({ viewCount: 3, lastViewedAt: daysAfterPick(0.1) }),
      now: daysAfterPick(1),
    });
    expect(out.kind).toBe("watched");
  });

  it("counts stopping in the credits as watched even before Plex ticks over", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: state({ viewOffset: RUNTIME * (COMPLETION_FRACTION + 0.02), lastViewedAt: daysAfterPick(0.1) }),
      now: daysAfterPick(1),
    });
    expect(out.kind).toBe("watched");
  });
});

describe("classifyPickOutcome — the abandoned-then-resumed case", () => {
  // The scenario that motivated this whole module: someone stops 20 minutes
  // in, life happens, and they pick it back up days later. A verdict taken at
  // stop time would have been wrong.
  const twentyMinutesIn = state({ viewOffset: 20 * 60 * 1000, lastViewedAt: daysAfterPick(0.02) });

  it("does not call it abandoned the moment they stop", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: twentyMinutesIn,
      now: daysAfterPick(0.1),
    });
    expect(out.kind).toBe("unresolved");
  });

  it("is still unresolved three days later — nothing has been decided", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: twentyMinutesIn,
      now: daysAfterPick(3),
    });
    expect(out.kind).toBe("unresolved");
  });

  it("resolves to watched once they come back and finish it", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: state({ viewCount: 1, viewOffset: RUNTIME, lastViewedAt: daysAfterPick(3) }),
      now: daysAfterPick(4),
    });
    expect(out.kind).toBe("watched");
  });

  it("a resume after a long gap re-opens a pick that had gone stale", () => {
    // Same pick, evaluated twice. The verdict is derived, never stored, so a
    // late resume simply changes the answer.
    const stale = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: twentyMinutesIn,
      now: daysAfterPick(RESUME_GRACE_DAYS + 5),
    });
    expect(stale.kind).toBe("abandoned");

    const resumed = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: state({
        viewOffset: 40 * 60 * 1000,
        lastViewedAt: daysAfterPick(RESUME_GRACE_DAYS + 6),
      }),
      now: daysAfterPick(RESUME_GRACE_DAYS + 6.5),
    });
    expect(resumed.kind).toBe("unresolved");
  });
});

describe("classifyPickOutcome — abandonment never becomes a negative", () => {
  it("a stalled part-watch is abandoned, and callers exclude rather than negate", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: state({ viewOffset: 10 * 60 * 1000, lastViewedAt: daysAfterPick(0.02) }),
      now: daysAfterPick(RESUME_GRACE_DAYS + 1),
    });
    expect(out.kind).toBe("abandoned");
    // The type has no "disliked" member at all — the exclusion is structural,
    // not a convention a caller has to remember.
    expect(["watched", "unresolved", "abandoned"]).toContain(out.kind);
  });

  it("never started, inside the grace period, is unresolved not abandoned", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: state(),
      now: daysAfterPick(RESUME_GRACE_DAYS - 1),
    });
    expect(out.kind).toBe("unresolved");
  });

  it("never started, past the grace period, is abandoned", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: state(),
      now: daysAfterPick(RESUME_GRACE_DAYS + 1),
    });
    expect(out.kind).toBe("abandoned");
  });
});

describe("classifyPickOutcome — missing data degrades safely", () => {
  it("no Plex row at all: they may have watched it elsewhere, so not a positive", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline(),
      state: null,
      now: daysAfterPick(1),
    });
    expect(out.kind).toBe("abandoned");
  });

  it("a pick predating baseline capture is unresolved, never guessed at", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: null,
      state: state({ viewCount: 5 }),
      now: daysAfterPick(1),
    });
    expect(out.kind).toBe("unresolved");
  });

  it("unknown duration falls back to viewCount rather than dividing by zero", () => {
    const out = classifyPickOutcome({
      pickedAt: PICKED_AT,
      baseline: baseline({ durationAtPick: null }),
      state: state({ viewCount: 1, duration: null, lastViewedAt: daysAfterPick(0.1) }),
      now: daysAfterPick(1),
    });
    expect(out.kind).toBe("watched");
  });
});

describe("readBaseline", () => {
  it("extracts a stored baseline", () => {
    const json = JSON.stringify({ mode: "discover", baseline: { viewCountAtPick: 1 } });
    expect(readBaseline(json)?.viewCountAtPick).toBe(1);
  });

  it("returns null for the old context shape, malformed JSON, and null", () => {
    expect(readBaseline(JSON.stringify({ mode: "discover", filters: {} }))).toBeNull();
    expect(readBaseline("{not json")).toBeNull();
    expect(readBaseline(null)).toBeNull();
  });
});
