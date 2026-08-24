import { describe, expect, it } from "vitest";
import type { TmdbDetailsResponse } from "./client";
import { mapTmdbDetails } from "./mapper";

const MOVIE_FIXTURE: TmdbDetailsResponse = {
  id: 634649,
  title: "Spider-Man: No Way Home",
  release_date: "2021-12-15",
  runtime: 148,
  overview: "With Spider-Man's identity now revealed...",
  poster_path: "/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg",
  genres: [
    { id: 28, name: "Action" },
    { id: 12, name: "Adventure" },
  ],
  credits: {
    cast: [
      { name: "Zendaya", order: 1 },
      { name: "Tom Holland", order: 0 },
      { name: "Benedict Cumberbatch", order: 2 },
    ],
    crew: [
      { name: "Jon Watts", job: "Director" },
      { name: "Amy Pascal", job: "Producer" },
      { name: "Christopher McQuarrie", job: "Writer" },
    ],
  },
  keywords: {
    keywords: [{ id: 1, name: "multiverse" }],
  },
};

const TV_FIXTURE: TmdbDetailsResponse = {
  id: 77680,
  name: "A Show I Logged",
  first_air_date: "2020-03-01",
  episode_run_time: [42, 45],
  overview: "A show.",
  poster_path: null,
  genres: [{ id: 18, name: "Drama" }],
  credits: {
    cast: [{ name: "Someone", order: 0 }],
    crew: [
      { name: "Director One", job: "Director" },
      { name: "Director Two", job: "Director" },
    ],
  },
  // TV keyword responses nest under "results", not "keywords" — the other
  // shape TMDB uses for this same field (see MOVIE_FIXTURE below).
  keywords: {
    results: [{ id: 2, name: "anthology" }],
  },
};

describe("mapTmdbDetails", () => {
  it("maps a movie response into the titles shape", () => {
    const mapped = mapTmdbDetails(MOVIE_FIXTURE, "movie");
    expect(mapped.title).toBe("Spider-Man: No Way Home");
    expect(mapped.year).toBe(2021);
    expect(mapped.runtime).toBe(148);
    expect(mapped.genres).toEqual(["Action", "Adventure"]);
    expect(mapped.overview).toBe("With Spider-Man's identity now revealed...");
    expect(mapped.posterPath).toBe("/1g0dhYtq4irTY1GPXvft6k4YLjm.jpg");
  });

  it("extracts only crew members whose job is Director", () => {
    const mapped = mapTmdbDetails(MOVIE_FIXTURE, "movie");
    expect(mapped.directors).toEqual(["Jon Watts"]);
    expect(mapped.directors).not.toContain("Amy Pascal");
    expect(mapped.directors).not.toContain("Christopher McQuarrie");
  });

  it("supports multiple directors", () => {
    const mapped = mapTmdbDetails(TV_FIXTURE, "tv");
    expect(mapped.directors).toEqual(["Director One", "Director Two"]);
  });

  it("sorts cast by billing order", () => {
    const mapped = mapTmdbDetails(MOVIE_FIXTURE, "movie");
    expect(mapped.cast).toEqual(["Tom Holland", "Zendaya", "Benedict Cumberbatch"]);
  });

  it("extracts keywords from a movie response's keywords.keywords shape", () => {
    const mapped = mapTmdbDetails(MOVIE_FIXTURE, "movie");
    expect(mapped.keywords).toEqual(["multiverse"]);
  });

  it("extracts keywords from a tv response's keywords.results shape", () => {
    const mapped = mapTmdbDetails(TV_FIXTURE, "tv");
    expect(mapped.keywords).toEqual(["anthology"]);
  });

  it("returns an empty array when TMDB returns no keywords", () => {
    const noKeywords: TmdbDetailsResponse = {
      id: 99,
      title: "No Keywords",
      keywords: { keywords: [] },
    };
    const mapped = mapTmdbDetails(noKeywords, "movie");
    expect(mapped.keywords).toEqual([]);
  });

  it("maps a tv response using name/first_air_date/episode_run_time", () => {
    const mapped = mapTmdbDetails(TV_FIXTURE, "tv");
    expect(mapped.title).toBe("A Show I Logged");
    expect(mapped.year).toBe(2020);
    expect(mapped.runtime).toBe(42); // first episode_run_time entry
    expect(mapped.posterPath).toBeNull();
  });

  it("falls back to a placeholder title and null year/runtime when fields are missing", () => {
    const mapped = mapTmdbDetails({ id: 42 }, "movie");
    expect(mapped.title).toBe("Unknown (42)");
    expect(mapped.year).toBeNull();
    expect(mapped.runtime).toBeNull();
    expect(mapped.genres).toEqual([]);
    expect(mapped.directors).toEqual([]);
    expect(mapped.cast).toEqual([]);
    expect(mapped.keywords).toEqual([]);
    expect(mapped.overview).toBeNull();
    expect(mapped.posterPath).toBeNull();
  });

  it("caps cast at the top 10 billed members", () => {
    const bigCast: TmdbDetailsResponse = {
      id: 1,
      title: "Big Cast",
      credits: {
        cast: Array.from({ length: 20 }, (_, i) => ({ name: `Actor ${i}`, order: i })),
      },
    };
    const mapped = mapTmdbDetails(bigCast, "movie");
    expect(mapped.cast).toHaveLength(10);
    expect(mapped.cast[0]).toBe("Actor 0");
  });
});
