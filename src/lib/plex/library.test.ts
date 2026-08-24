import { describe, expect, it } from "vitest";
import {
  buildAllShowsPath,
  buildWatchedEpisodesPath,
  buildWatchedMoviesPath,
  isInProgress,
  isShowFullyWatched,
  normalizePlexVideo,
  rollupEpisodesToShows,
  type NormalizedPlexItem,
} from "./library";

describe("normalizePlexVideo (constraint 8 — defensive coercion)", () => {
  it("coerces numeric-as-string attributes", () => {
    const item = normalizePlexVideo({
      ratingKey: "123",
      title: "Some Movie",
      year: "1999",
      viewCount: "2",
      lastViewedAt: "1700000000",
      viewOffset: "45000",
    });
    expect(item).toMatchObject({
      ratingKey: "123",
      year: 1999,
      viewCount: 2,
      lastViewedAt: 1700000000,
      viewOffset: 45000,
    });
  });

  it("handles a genuinely numeric payload too", () => {
    const item = normalizePlexVideo({ ratingKey: "1", viewCount: 3, year: 2001 });
    expect(item).toMatchObject({ viewCount: 3, year: 2001 });
  });

  it("defaults viewCount to 0 rather than undefined when absent", () => {
    const item = normalizePlexVideo({ ratingKey: "1" });
    expect(item?.viewCount).toBe(0);
  });

  it("returns null when ratingKey is missing entirely", () => {
    expect(normalizePlexVideo({})).toBeNull();
  });

  it("extracts external ids via the same guid logic (modern Guid children)", () => {
    const item = normalizePlexVideo({
      ratingKey: "1",
      Guid: [{ id: "tmdb://603" }],
    });
    expect(item?.externalIds.tmdbId).toBe(603);
  });
});

describe("isInProgress", () => {
  it("is true when viewOffset is set and viewCount is 0", () => {
    expect(isInProgress({ viewCount: 0, viewOffset: 12000 })).toBe(true);
  });

  it("is false once viewCount > 0 even with a stale viewOffset", () => {
    expect(isInProgress({ viewCount: 1, viewOffset: 12000 })).toBe(false);
  });

  it("is false when there's no viewOffset at all", () => {
    expect(isInProgress({ viewCount: 0, viewOffset: undefined })).toBe(false);
  });
});

describe("isShowFullyWatched (constraint 6)", () => {
  it("is true when leafCount equals viewedLeafCount", () => {
    expect(isShowFullyWatched({ leafCount: 10, viewedLeafCount: 10 })).toBe(true);
  });

  it("is false when they differ", () => {
    expect(isShowFullyWatched({ leafCount: 10, viewedLeafCount: 7 })).toBe(false);
  });

  it("is false when either is missing (e.g. a movie item)", () => {
    expect(isShowFullyWatched({})).toBe(false);
    expect(isShowFullyWatched({ leafCount: 10 })).toBe(false);
  });
});

function episode(overrides: Partial<NormalizedPlexItem>): NormalizedPlexItem {
  return {
    ratingKey: "ep",
    title: "",
    viewCount: 1,
    grandparentRatingKey: "show-1",
    externalIds: { tmdbId: null, imdbId: null, tvdbId: null },
    ...overrides,
  };
}

describe("rollupEpisodesToShows (constraint 6)", () => {
  it("sums episode viewCount per show — never a show-level viewCount field", () => {
    const episodes = [
      episode({ ratingKey: "e1", viewCount: 1 }),
      episode({ ratingKey: "e2", viewCount: 2 }), // rewatched once
      episode({ ratingKey: "e3", viewCount: 1 }),
    ];
    const rollups = rollupEpisodesToShows(episodes);
    const show = rollups.get("show-1");
    expect(show?.totalEpisodeViewCount).toBe(4);
    expect(show?.watchedEpisodeCount).toBe(3);
  });

  it("tracks the max lastViewedAt across episodes", () => {
    const episodes = [
      episode({ ratingKey: "e1", lastViewedAt: 100 }),
      episode({ ratingKey: "e2", lastViewedAt: 300 }),
      episode({ ratingKey: "e3", lastViewedAt: 200 }),
    ];
    expect(rollupEpisodesToShows(episodes).get("show-1")?.lastViewedAt).toBe(300);
  });

  it("collects in-progress episodes (viewOffset set, viewCount 0) separately from watched ones", () => {
    const episodes = [
      episode({ ratingKey: "e1", viewCount: 1 }),
      episode({ ratingKey: "e2", viewCount: 0, viewOffset: 5000 }),
    ];
    const rollup = rollupEpisodesToShows(episodes).get("show-1");
    expect(rollup?.inProgressEpisodeRatingKeys).toEqual(["e2"]);
    expect(rollup?.watchedEpisodeCount).toBe(1);
  });

  it("keeps separate shows separate", () => {
    const episodes = [
      episode({ ratingKey: "e1", grandparentRatingKey: "show-a", viewCount: 1 }),
      episode({ ratingKey: "e2", grandparentRatingKey: "show-b", viewCount: 5 }),
    ];
    const rollups = rollupEpisodesToShows(episodes);
    expect(rollups.get("show-a")?.totalEpisodeViewCount).toBe(1);
    expect(rollups.get("show-b")?.totalEpisodeViewCount).toBe(5);
  });

  it("skips episodes with no grandparentRatingKey rather than crashing", () => {
    const episodes = [episode({ ratingKey: "e1", grandparentRatingKey: undefined })];
    expect(rollupEpisodesToShows(episodes).size).toBe(0);
  });
});

describe("scan path builders (constraint 5 — %3E%3D encoding)", () => {
  it("URL-encodes >= as %3E%3D for movies", () => {
    const path = buildWatchedMoviesPath("1", 0, 1000, false);
    expect(path).toContain("viewCount%3E%3D1");
    expect(path).not.toContain(">=");
    expect(path).toContain("type=1");
    expect(path).toContain("sort=lastViewedAt:desc");
  });

  it("URL-encodes >= as %3E%3D for episodes", () => {
    const path = buildWatchedEpisodesPath("2", 0, 1000, false);
    expect(path).toContain("viewCount%3E%3D1");
    expect(path).toContain("type=4");
  });

  it("includes includeGuids=1 only when requested", () => {
    expect(buildWatchedMoviesPath("1", 0, 100, true)).toContain("includeGuids=1");
    expect(buildWatchedMoviesPath("1", 0, 100, false)).not.toContain("includeGuids");
  });

  it("carries pagination params", () => {
    const path = buildWatchedMoviesPath("1", 500, 1000, false);
    expect(path).toContain("X-Plex-Container-Start=500");
    expect(path).toContain("X-Plex-Container-Size=1000");
  });

  it("builds an unfiltered all-shows path (type=2, no viewCount filter)", () => {
    const path = buildAllShowsPath("3", 0, 1000);
    expect(path).toContain("type=2");
    expect(path).not.toContain("viewCount");
  });
});
