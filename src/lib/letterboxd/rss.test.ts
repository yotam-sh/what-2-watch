import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertValidLetterboxdUsername,
  fetchLetterboxdRssXml,
  InvalidLetterboxdUsernameError,
  LetterboxdFetchError,
  LetterboxdUserNotFoundError,
  parseLetterboxdRss,
  selectNewEntries,
} from "./rss";

const FIXTURE_XML = fs.readFileSync(path.join(__dirname, "__fixtures__/diary.rss.xml"), "utf-8");

describe("parseLetterboxdRss", () => {
  it("parses exactly the letterboxd-watch- diary entries, skipping letterboxd-list- stubs", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);

    // Fixture has 4 diary items and 2 list stubs.
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.guid.startsWith("letterboxd-watch-"))).toBe(true);
    expect(entries.some((e) => e.guid.startsWith("letterboxd-list-"))).toBe(false);
  });

  it("returns entries newest-first, matching feed order", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    expect(entries.map((e) => e.guid)).toEqual([
      "letterboxd-watch-1447297802",
      "letterboxd-watch-1445590413",
      "letterboxd-watch-1444388109",
      "letterboxd-watch-1440000001",
    ]);
  });

  it("treats a missing memberRating as undefined, never 0", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    const unrated = entries.find((e) => e.guid === "letterboxd-watch-1445590413");
    expect(unrated).toBeDefined();
    expect(unrated!.memberRating).toBeUndefined();
    expect(unrated!.memberRating).not.toBe(0);
  });

  it("parses a present memberRating as a number", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    const rated = entries.find((e) => e.guid === "letterboxd-watch-1447297802");
    expect(rated?.memberRating).toBe(4.0);

    const halfStar = entries.find((e) => e.guid === "letterboxd-watch-1444388109");
    expect(halfStar?.memberRating).toBe(3.5);
  });

  it("extracts tmdb:movieId as a movie", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    const movie = entries.find((e) => e.guid === "letterboxd-watch-1447297802");
    expect(movie?.tmdbId).toBe(1368337);
    expect(movie?.mediaType).toBe("movie");
  });

  it("extracts tmdb:tvId as tv", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    const tv = entries.find((e) => e.guid === "letterboxd-watch-1440000001");
    expect(tv?.tmdbId).toBe(77680);
    expect(tv?.mediaType).toBe("tv");
  });

  it("maps rewatch Yes/No to boolean", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    const notRewatch = entries.find((e) => e.guid === "letterboxd-watch-1447297802");
    const isRewatch = entries.find((e) => e.guid === "letterboxd-watch-1444388109");
    expect(notRewatch?.isRewatch).toBe(false);
    expect(isRewatch?.isRewatch).toBe(true);
  });

  it("maps memberLike Yes/No to boolean", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    const liked = entries.find((e) => e.guid === "letterboxd-watch-1447297802");
    const disliked = entries.find((e) => e.guid === "letterboxd-watch-1440000001");
    expect(liked?.memberLike).toBe(true);
    expect(disliked?.memberLike).toBe(false);
  });

  it("parses watchedDate as a real Date", () => {
    const entries = parseLetterboxdRss(FIXTURE_XML);
    const entry = entries.find((e) => e.guid === "letterboxd-watch-1447297802");
    expect(entry?.watchedDate).toBeInstanceOf(Date);
    expect(entry?.watchedDate.toISOString().slice(0, 10)).toBe("2026-08-12");
  });

  it("skips a diary-guid item that has neither tmdb:movieId nor tmdb:tvId", () => {
    const xmlWithoutTmdbId = `<?xml version='1.0'?>
      <rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
        <channel>
          <item>
            <guid isPermaLink="false">letterboxd-watch-999</guid>
            <letterboxd:watchedDate>2026-01-01</letterboxd:watchedDate>
            <letterboxd:filmTitle>No TMDB Match</letterboxd:filmTitle>
          </item>
        </channel>
      </rss>`;
    expect(parseLetterboxdRss(xmlWithoutTmdbId)).toHaveLength(0);
  });

  it("returns an empty array for a feed with no items", () => {
    const empty = `<?xml version='1.0'?><rss><channel><title>Empty</title></channel></rss>`;
    expect(parseLetterboxdRss(empty)).toEqual([]);
  });
});

describe("selectNewEntries (guid high-water-mark dedupe)", () => {
  const entries = parseLetterboxdRss(FIXTURE_XML); // newest-first, 4 entries

  it("returns everything when there is no stored high-water mark (first sync)", () => {
    expect(selectNewEntries(entries, null)).toHaveLength(4);
    expect(selectNewEntries(entries, undefined)).toHaveLength(4);
  });

  it("returns only entries newer than the stored guid", () => {
    const fresh = selectNewEntries(entries, "letterboxd-watch-1444388109");
    expect(fresh.map((e) => e.guid)).toEqual([
      "letterboxd-watch-1447297802",
      "letterboxd-watch-1445590413",
    ]);
  });

  it("returns nothing when the stored guid is the newest entry", () => {
    const fresh = selectNewEntries(entries, "letterboxd-watch-1447297802");
    expect(fresh).toHaveLength(0);
  });

  it("falls back to everything when the stored guid has scrolled out of the feed window", () => {
    const fresh = selectNewEntries(entries, "letterboxd-watch-some-old-guid-not-in-feed");
    expect(fresh).toHaveLength(4);
  });
});

describe("assertValidLetterboxdUsername", () => {
  it("accepts a valid username", () => {
    expect(() => assertValidLetterboxdUsername("dave")).not.toThrow();
    expect(() => assertValidLetterboxdUsername("test_user_1")).not.toThrow();
  });

  it("rejects usernames outside Letterboxd's permitted character set", () => {
    expect(() => assertValidLetterboxdUsername("a")).toThrow(InvalidLetterboxdUsernameError); // too short
    expect(() => assertValidLetterboxdUsername("way-too-long-for-letterboxd")).toThrow(
      InvalidLetterboxdUsernameError,
    );
    expect(() => assertValidLetterboxdUsername("has spaces")).toThrow(InvalidLetterboxdUsernameError);
    expect(() => assertValidLetterboxdUsername("has-hyphen")).toThrow(InvalidLetterboxdUsernameError);
    expect(() => assertValidLetterboxdUsername("../../etc/passwd")).toThrow(InvalidLetterboxdUsernameError);
  });
});

describe("fetchLetterboxdRssXml", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the response body on success", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(FIXTURE_XML, { status: 200 }) as unknown as Response,
    );
    const xml = await fetchLetterboxdRssXml("dave");
    expect(xml).toBe(FIXTURE_XML);
  });

  it("throws LetterboxdUserNotFoundError on a 404 (unknown, private, or deactivated user)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 404 }) as unknown as Response);
    await expect(fetchLetterboxdRssXml("zzzznonexistent")).rejects.toThrow(LetterboxdUserNotFoundError);
  });

  it("throws LetterboxdFetchError on other non-2xx statuses", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 503 }) as unknown as Response);
    await expect(fetchLetterboxdRssXml("dave")).rejects.toThrow(LetterboxdFetchError);
  });

  it("throws InvalidLetterboxdUsernameError before ever calling fetch", async () => {
    await expect(fetchLetterboxdRssXml("not valid!")).rejects.toThrow(InvalidLetterboxdUsernameError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends a descriptive User-Agent header", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response(FIXTURE_XML, { status: 200 }) as unknown as Response);
    await fetchLetterboxdRssXml("dave");
    const [, init] = vi.mocked(global.fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/what-to-watch/);
  });
});
