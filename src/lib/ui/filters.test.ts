import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  describeActiveFilters,
  filtersReducer,
  hasActiveFilters,
  INITIAL_FILTERS,
  toApiFilters,
  type DecideFilters,
} from "./filters";

describe("filtersReducer", () => {
  it("starts with everything off", () => {
    expect(INITIAL_FILTERS).toEqual({ maxRuntimeMinutes: null, decade: null, genre: null });
  });

  it("sets max runtime independently of other fields", () => {
    const next = filtersReducer(INITIAL_FILTERS, { type: "SET_MAX_RUNTIME", minutes: 90 });
    expect(next).toEqual({ maxRuntimeMinutes: 90, decade: null, genre: null });
  });

  it("sets decade", () => {
    const next = filtersReducer(INITIAL_FILTERS, { type: "SET_DECADE", decade: 1990 });
    expect(next.decade).toBe(1990);
  });

  it("sets genre", () => {
    const next = filtersReducer(INITIAL_FILTERS, { type: "SET_GENRE", genre: "Comedy" });
    expect(next.genre).toBe("Comedy");
  });

  it("clears a field by passing null", () => {
    const withRuntime: DecideFilters = { maxRuntimeMinutes: 90, decade: null, genre: null };
    const cleared = filtersReducer(withRuntime, { type: "SET_MAX_RUNTIME", minutes: null });
    expect(cleared.maxRuntimeMinutes).toBeNull();
  });

  it("composes multiple filters without clobbering each other", () => {
    let state = INITIAL_FILTERS;
    state = filtersReducer(state, { type: "SET_MAX_RUNTIME", minutes: 120 });
    state = filtersReducer(state, { type: "SET_DECADE", decade: 2000 });
    state = filtersReducer(state, { type: "SET_GENRE", genre: "Horror" });
    expect(state).toEqual({ maxRuntimeMinutes: 120, decade: 2000, genre: "Horror" });
  });

  it("RESET returns to the initial (all-off) state", () => {
    let state = INITIAL_FILTERS;
    state = filtersReducer(state, { type: "SET_MAX_RUNTIME", minutes: 90 });
    state = filtersReducer(state, { type: "SET_DECADE", decade: 1980 });
    state = filtersReducer(state, { type: "RESET" });
    expect(state).toEqual(INITIAL_FILTERS);
  });

  it("RESET returns the exact defaults from an arbitrary fully-populated state", () => {
    const arbitrary: DecideFilters = { maxRuntimeMinutes: 100, decade: 2010, genre: "Action" };
    expect(filtersReducer(arbitrary, { type: "RESET" })).toEqual(INITIAL_FILTERS);
  });
});

describe("activeFilterCount", () => {
  it("is 0 for the default state", () => {
    expect(activeFilterCount(INITIAL_FILTERS)).toBe(0);
  });

  it("counts each non-default field independently", () => {
    expect(activeFilterCount({ maxRuntimeMinutes: 90, decade: null, genre: null })).toBe(1);
    expect(activeFilterCount({ maxRuntimeMinutes: 90, decade: 1990, genre: null })).toBe(2);
    expect(activeFilterCount({ maxRuntimeMinutes: 90, decade: 1990, genre: "Comedy" })).toBe(3);
  });

  it("does not count a field explicitly set back to its default", () => {
    let state = INITIAL_FILTERS;
    state = filtersReducer(state, { type: "SET_MAX_RUNTIME", minutes: 90 });
    state = filtersReducer(state, { type: "SET_MAX_RUNTIME", minutes: null });
    expect(activeFilterCount(state)).toBe(0);
  });

  it("drops back to matching hasActiveFilters after RESET", () => {
    let state: DecideFilters = { maxRuntimeMinutes: 90, decade: 1990, genre: "Comedy" };
    state = filtersReducer(state, { type: "RESET" });
    expect(activeFilterCount(state)).toBe(0);
    expect(hasActiveFilters(state)).toBe(false);
  });
});

describe("hasActiveFilters", () => {
  it("is false when nothing is set", () => {
    expect(hasActiveFilters(INITIAL_FILTERS)).toBe(false);
  });

  it("is true when any single field is set", () => {
    expect(hasActiveFilters({ maxRuntimeMinutes: 90, decade: null, genre: null })).toBe(true);
    expect(hasActiveFilters({ maxRuntimeMinutes: null, decade: 1990, genre: null })).toBe(true);
    expect(hasActiveFilters({ maxRuntimeMinutes: null, decade: null, genre: "Drama" })).toBe(true);
  });
});

describe("toApiFilters", () => {
  it("omits every field when nothing is active", () => {
    expect(toApiFilters(INITIAL_FILTERS)).toEqual({});
  });

  it("maps genre to a single-element includeGenres array", () => {
    expect(toApiFilters({ maxRuntimeMinutes: null, decade: null, genre: "Sci-Fi" })).toEqual({
      includeGenres: ["Sci-Fi"],
    });
  });

  it("maps all three fields together", () => {
    expect(toApiFilters({ maxRuntimeMinutes: 100, decade: 2010, genre: "Action" })).toEqual({
      maxRuntimeMinutes: 100,
      decade: 2010,
      includeGenres: ["Action"],
    });
  });
});

describe("describeActiveFilters", () => {
  it("returns an empty array when nothing is active", () => {
    expect(describeActiveFilters(INITIAL_FILTERS)).toEqual([]);
  });

  it("describes each active filter as a readable fragment", () => {
    expect(describeActiveFilters({ maxRuntimeMinutes: 90, decade: 1990, genre: "Comedy" })).toEqual([
      "under 90m",
      "1990s",
      "Comedy",
    ]);
  });
});
