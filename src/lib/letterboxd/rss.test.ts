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

// Bug 1 regression: a `letterboxd-review-` item is a diary entry that
// happens to have a review attached — structurally identical to a
// `letterboxd-watch-` item apart from the guid prefix. The old code treated
// `letterboxd-watch-` as *the* diary prefix and silently dropped every
// reviewed film (94% of a real diary in the wild). Detection must be
// structural (filmTitle + a tmdb id), not prefix-based, so it also survives
// whatever prefix Letterboxd mints next.
describe("parseLetterboxdRss — diary detection is structural, not guid-prefix-based", () => {
  const MIXED_PREFIX_XML = `<?xml version='1.0'?>
    <rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
      <channel>
        <item>
          <guid isPermaLink="false">letterboxd-review-1466005631</guid>
          <letterboxd:watchedDate>2026-08-23</letterboxd:watchedDate>
          <letterboxd:rewatch>Yes</letterboxd:rewatch>
          <letterboxd:filmTitle>Harry Potter and the Goblet of Fire</letterboxd:filmTitle>
          <letterboxd:filmYear>2005</letterboxd:filmYear>
          <letterboxd:memberRating>4.0</letterboxd:memberRating>
          <letterboxd:memberLike>Yes</letterboxd:memberLike>
          <tmdb:movieId>674</tmdb:movieId>
        </item>
        <item>
          <guid isPermaLink="false">letterboxd-watch-1448514291</guid>
          <letterboxd:watchedDate>2026-08-20</letterboxd:watchedDate>
          <letterboxd:rewatch>No</letterboxd:rewatch>
          <letterboxd:filmTitle>Some Watched Film</letterboxd:filmTitle>
          <letterboxd:filmYear>2019</letterboxd:filmYear>
          <tmdb:movieId>1000</tmdb:movieId>
        </item>
        <item>
          <guid isPermaLink="false">letterboxd-list-1909712</guid>
          <title>Ranked: Denis Villeneuve</title>
          <description><![CDATA[<p>A ranked list, not a diary entry.</p>]]></description>
        </item>
      </channel>
    </rss>`;

  it("parses both letterboxd-review- and letterboxd-watch- items as diary entries, skipping only the list stub", () => {
    const entries = parseLetterboxdRss(MIXED_PREFIX_XML);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.guid)).toEqual([
      "letterboxd-review-1466005631",
      "letterboxd-watch-1448514291",
    ]);
    expect(entries.every((e) => !e.guid.startsWith("letterboxd-list-"))).toBe(true);
  });

  it("fully parses a letterboxd-review- entry's fields, not just its presence", () => {
    const entries = parseLetterboxdRss(MIXED_PREFIX_XML);
    const review = entries.find((e) => e.guid === "letterboxd-review-1466005631");
    expect(review).toMatchObject({
      tmdbId: 674,
      mediaType: "movie",
      filmTitle: "Harry Potter and the Goblet of Fire",
      filmYear: 2005,
      isRewatch: true,
      memberRating: 4.0,
      memberLike: true,
    });
  });

  it("skips an item under an entirely unrecognized guid prefix if it lacks diary shape, and accepts one that has it", () => {
    const xml = `<?xml version='1.0'?>
      <rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
        <channel>
          <item>
            <guid isPermaLink="false">letterboxd-some-future-kind-42</guid>
            <letterboxd:watchedDate>2026-08-01</letterboxd:watchedDate>
            <letterboxd:filmTitle>Diary Entry Under A Novel Prefix</letterboxd:filmTitle>
            <tmdb:movieId>555</tmdb:movieId>
          </item>
          <item>
            <guid isPermaLink="false">letterboxd-some-future-kind-43</guid>
            <description><![CDATA[<p>No filmTitle, no tmdb id — not a diary entry.</p>]]></description>
          </item>
        </channel>
      </rss>`;
    const entries = parseLetterboxdRss(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ guid: "letterboxd-some-future-kind-42", tmdbId: 555 });
  });

  it("skips a diary-shaped item (filmTitle present) when it has no usable tmdb id at all", () => {
    const xml = `<?xml version='1.0'?>
      <rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
        <channel>
          <item>
            <guid isPermaLink="false">letterboxd-review-777</guid>
            <letterboxd:watchedDate>2026-08-01</letterboxd:watchedDate>
            <letterboxd:filmTitle>No TMDB Match Reviewed</letterboxd:filmTitle>
          </item>
        </channel>
      </rss>`;
    expect(parseLetterboxdRss(xml)).toHaveLength(0);
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

// Bug 1's dedupe angle: the stored `last_guid_seen` high-water mark predates
// the fix, so it's necessarily a `letterboxd-watch-` guid (the only prefix
// the old code ever recognized as diary). After the fix, newly-visible
// `letterboxd-review-` entries can be *newer* than that stored mark. Prove
// selectNewEntries picks them up correctly — it works purely off array
// position in the newest-first feed order, never off the guid's own prefix
// or numeric value, so it doesn't matter that the mark "looks recent".
describe("selectNewEntries with mixed guid prefixes (bug 1 backlog regression)", () => {
  const MIXED_XML = `<?xml version='1.0'?>
    <rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
      <channel>
        <item>
          <guid isPermaLink="false">letterboxd-review-3</guid>
          <letterboxd:watchedDate>2026-08-23</letterboxd:watchedDate>
          <letterboxd:filmTitle>Newest, Reviewed</letterboxd:filmTitle>
          <tmdb:movieId>3</tmdb:movieId>
        </item>
        <item>
          <guid isPermaLink="false">letterboxd-watch-2</guid>
          <letterboxd:watchedDate>2026-08-22</letterboxd:watchedDate>
          <letterboxd:filmTitle>Middle, Plain Watch (the stored high-water mark)</letterboxd:filmTitle>
          <tmdb:movieId>2</tmdb:movieId>
        </item>
        <item>
          <guid isPermaLink="false">letterboxd-review-1</guid>
          <letterboxd:watchedDate>2026-08-21</letterboxd:watchedDate>
          <letterboxd:filmTitle>Oldest, Reviewed</letterboxd:filmTitle>
          <tmdb:movieId>1</tmdb:movieId>
        </item>
      </channel>
    </rss>`;
  const mixedEntries = parseLetterboxdRss(MIXED_XML); // newest-first: review-3, watch-2, review-1

  it("returns only the newer letterboxd-review- entry, correctly ignoring the older one, when the mark is an older letterboxd-watch- guid", () => {
    const fresh = selectNewEntries(mixedEntries, "letterboxd-watch-2");
    expect(fresh.map((e) => e.guid)).toEqual(["letterboxd-review-3"]);
  });

  it("on first sync (no stored mark), returns the full backlog across both prefixes", () => {
    expect(selectNewEntries(mixedEntries, null).map((e) => e.guid)).toEqual([
      "letterboxd-review-3",
      "letterboxd-watch-2",
      "letterboxd-review-1",
    ]);
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
