import { describe, expect, it } from "vitest";
import { selectDecideViewState, type DecideViewInput } from "./emptyState";

const BASE: DecideViewInput = {
  plexLinked: false,
  letterboxdLinked: false,
  plexSyncedAt: null,
  letterboxdSyncedAt: null,
  candidates: null,
  activeFilterDescriptions: [],
  fetchError: null,
};

describe("selectDecideViewState", () => {
  it("brand-new account with nothing linked guides to Settings, not a broken roll", () => {
    expect(selectDecideViewState(BASE)).toEqual({ kind: "no-links" });
  });

  it("still loading (no request completed yet) is distinct from empty results", () => {
    const input: DecideViewInput = { ...BASE, plexLinked: true, plexSyncedAt: new Date(), candidates: null };
    expect(selectDecideViewState(input)).toEqual({ kind: "loading" });
  });

  it("linked but never synced explains and offers the sync, rather than claiming no matches", () => {
    const input: DecideViewInput = {
      ...BASE,
      plexLinked: true,
      plexSyncedAt: null,
      candidates: [],
    };
    expect(selectDecideViewState(input)).toEqual({ kind: "not-synced", sources: ["plex"] });
  });

  it("reports both sources when both are linked but unsynced", () => {
    const input: DecideViewInput = {
      ...BASE,
      plexLinked: true,
      letterboxdLinked: true,
      plexSyncedAt: null,
      letterboxdSyncedAt: null,
      candidates: [],
    };
    expect(selectDecideViewState(input)).toEqual({ kind: "not-synced", sources: ["plex", "letterboxd"] });
  });

  it("synced but genuinely zero candidates says which filters are too tight", () => {
    const input: DecideViewInput = {
      ...BASE,
      plexLinked: true,
      plexSyncedAt: new Date(),
      candidates: [],
      activeFilterDescriptions: ["under 60m"],
    };
    expect(selectDecideViewState(input)).toEqual({ kind: "no-candidates", activeFilters: ["under 60m"] });
  });

  it("synced, zero candidates, no active filters -> no-candidates with an empty filter list", () => {
    const input: DecideViewInput = { ...BASE, plexLinked: true, plexSyncedAt: new Date(), candidates: [] };
    expect(selectDecideViewState(input)).toEqual({ kind: "no-candidates", activeFilters: [] });
  });

  it("non-empty candidates is always 'results', regardless of sync state", () => {
    const input: DecideViewInput = {
      ...BASE,
      plexLinked: true,
      plexSyncedAt: null,
      candidates: [{ id: 1 }],
    };
    expect(selectDecideViewState(input)).toEqual({ kind: "results" });
  });

  it("a 401 fetch error means the session expired, independent of link/sync state", () => {
    const input: DecideViewInput = {
      ...BASE,
      plexLinked: true,
      plexSyncedAt: new Date(),
      fetchError: { status: 401, message: "Not authenticated." },
    };
    expect(selectDecideViewState(input)).toEqual({ kind: "session-expired" });
  });

  it("a 502 fetch error means Plex is unreachable, said plainly rather than 'no results'", () => {
    const input: DecideViewInput = {
      ...BASE,
      plexLinked: true,
      fetchError: { status: 502, message: "Could not reach the linked Plex server on any known connection" },
    };
    expect(selectDecideViewState(input)).toEqual({
      kind: "plex-unreachable",
      message: "Could not reach the linked Plex server on any known connection",
    });
  });

  it("any other error status falls back to a generic server-error state", () => {
    const input: DecideViewInput = { ...BASE, fetchError: { status: 500, message: "boom" } };
    expect(selectDecideViewState(input)).toEqual({ kind: "server-error", message: "boom" });
  });

  it("fetchError takes precedence over no-links", () => {
    const input: DecideViewInput = { ...BASE, fetchError: { status: 401, message: "x" } };
    expect(selectDecideViewState(input)).toEqual({ kind: "session-expired" });
  });

  it("no-links takes precedence over not-synced/no-candidates", () => {
    // Nothing linked at all should never fall through to "no-candidates" —
    // that would tell a brand-new user to loosen filters they never set.
    expect(selectDecideViewState({ ...BASE, candidates: [] })).toEqual({ kind: "no-links" });
  });
});
