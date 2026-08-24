import { describe, expect, it } from "vitest";
import { extractExternalIds, needsGuidResolution } from "./guid";

describe("extractExternalIds", () => {
  it("parses modern Guid children (tmdb/imdb/tvdb)", () => {
    const item = {
      guid: "plex://movie/5d776b59fd0af8001f2d0555",
      Guid: [{ id: "tmdb://603" }, { id: "imdb://tt0133093" }, { id: "tvdb://12345" }],
    };
    expect(extractExternalIds(item)).toEqual({
      tmdbId: 603,
      imdbId: "tt0133093",
      tvdbId: "12345",
    });
  });

  it("parses a single Guid child that PMS/fast-xml-parser returned as a bare object, not an array", () => {
    const item = { Guid: { id: "tmdb://603" } as unknown as { id: string }[] };
    expect(extractExternalIds(item)).toEqual({ tmdbId: 603, imdbId: null, tvdbId: null });
  });

  it("parses a legacy com.plexapp.agents.themoviedb guid", () => {
    const item = { guid: "com.plexapp.agents.themoviedb://603?lang=en" };
    expect(extractExternalIds(item)).toEqual({ tmdbId: 603, imdbId: null, tvdbId: null });
  });

  it("parses a legacy com.plexapp.agents.imdb guid", () => {
    const item = { guid: "com.plexapp.agents.imdb://tt0133093?lang=en" };
    expect(extractExternalIds(item)).toEqual({ tmdbId: null, imdbId: "tt0133093", tvdbId: null });
  });

  it("parses a legacy com.plexapp.agents.thetvdb guid", () => {
    const item = { guid: "com.plexapp.agents.thetvdb://121361?lang=en" };
    expect(extractExternalIds(item)).toEqual({ tmdbId: null, imdbId: null, tvdbId: "121361" });
  });

  it("returns all-null for the no-id case (unmatched item, opaque plex:// guid only)", () => {
    const item = { guid: "plex://movie/5d776b59fd0af8001f2d0555" };
    expect(extractExternalIds(item)).toEqual({ tmdbId: null, imdbId: null, tvdbId: null });
  });

  it("returns all-null for a completely empty item", () => {
    expect(extractExternalIds({})).toEqual({ tmdbId: null, imdbId: null, tvdbId: null });
    expect(extractExternalIds(null)).toEqual({ tmdbId: null, imdbId: null, tvdbId: null });
    expect(extractExternalIds(undefined)).toEqual({ tmdbId: null, imdbId: null, tvdbId: null });
  });

  it("prefers the first id found per provider and doesn't let a later duplicate overwrite it", () => {
    const item = {
      Guid: [{ id: "tmdb://603" }, { id: "tmdb://999" }],
    };
    expect(extractExternalIds(item).tmdbId).toBe(603);
  });
});

describe("needsGuidResolution", () => {
  it("is true for a modern-agent item with no resolved ids (includeGuids didn't work)", () => {
    const item = { guid: "plex://movie/5d776b59fd0af8001f2d0555" };
    expect(needsGuidResolution(item)).toBe(true);
  });

  it("is false once Guid children resolved something", () => {
    const item = {
      guid: "plex://movie/5d776b59fd0af8001f2d0555",
      Guid: [{ id: "tmdb://603" }],
    };
    expect(needsGuidResolution(item)).toBe(false);
  });

  it("is false for a legacy-agent item (never has Guid children, but guid itself resolves)", () => {
    const item = { guid: "com.plexapp.agents.themoviedb://603?lang=en" };
    expect(needsGuidResolution(item)).toBe(false);
  });

  it("is false for a legacy-agent item with genuinely no id (rare, but shouldn't trigger a batch call)", () => {
    const item = { guid: "com.plexapp.agents.none://unknown" };
    expect(needsGuidResolution(item)).toBe(false);
  });
});
