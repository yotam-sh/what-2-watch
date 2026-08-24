import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAllMoviesPath,
  buildAllShowsPath,
  buildWatchedEpisodesPath,
  buildWatchedMoviesPath,
  isInProgress,
  isShowFullyWatched,
  normalizePlexVideo,
  PlexScanFailedError,
  resolveGuidsViaBatch,
  rollupEpisodesToShows,
  scanAllMovies,
  scanAllShows,
  scanWatchedMovies,
  type FetchCtx,
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

describe("scan path builders (bug B — raw vs %3E%3D-encoded viewCount filter)", () => {
  it("defaults to the %3E%3D-encoded filter when the 5th argument is omitted (backward compatible)", () => {
    expect(buildWatchedMoviesPath("1", 0, 100, false)).toContain("viewCount%3E%3D1");
    expect(buildWatchedEpisodesPath("2", 0, 100, false)).toContain("viewCount%3E%3D1");
  });

  it('emits the literal, un-encoded ">=" when viewCountFilter is "raw"', () => {
    const moviePath = buildWatchedMoviesPath("1", 0, 1000, false, "raw");
    expect(moviePath).toContain("viewCount>=1");
    expect(moviePath).not.toContain("%3E");
    expect(moviePath).toContain("type=1");
    expect(moviePath).toContain("sort=lastViewedAt:desc");

    const episodePath = buildWatchedEpisodesPath("2", 0, 1000, false, "raw");
    expect(episodePath).toContain("viewCount>=1");
    expect(episodePath).not.toContain("%3E");
    expect(episodePath).toContain("type=4");
  });

  it('URL-encodes >= as %3E%3D when viewCountFilter is "encoded"', () => {
    const path = buildWatchedMoviesPath("1", 0, 1000, false, "encoded");
    expect(path).toContain("viewCount%3E%3D1");
    expect(path).not.toContain(">=");
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

  it('omits the viewCount filter entirely when viewCountFilter is "none" (ladder floor rung)', () => {
    const moviePath = buildWatchedMoviesPath("1", 0, 100, false, "none");
    expect(moviePath).not.toContain("viewCount");
    expect(moviePath).toContain("type=1");

    const episodePath = buildWatchedEpisodesPath("2", 0, 100, false, "none");
    expect(episodePath).not.toContain("viewCount");
    expect(episodePath).toContain("type=4");
  });

  it("builds an unfiltered all-movies path (type=1, no viewCount filter — Phase 6 discover pool)", () => {
    const path = buildAllMoviesPath("1", 0, 1000, false);
    expect(path).toContain("type=1");
    expect(path).not.toContain("viewCount");
    expect(path).toContain("X-Plex-Container-Start=0");
    expect(path).toContain("X-Plex-Container-Size=1000");
    expect(path).not.toContain("includeGuids");
  });

  it("includes includeGuids=1 on the all-movies path only when requested", () => {
    expect(buildAllMoviesPath("1", 0, 1000, true)).toContain("includeGuids=1");
    expect(buildAllMoviesPath("1", 0, 1000, false)).not.toContain("includeGuids");
  });
});

// ---------------------------------------------------------------------------
// Bug A regressions — page extraction must go through the shared
// extractMediaContainerItems() guard (mediaContainer.ts), not read
// `.Video`/`.Directory`/`.Metadata` directly. These two exercise the exact
// shapes that used to come back with zero items despite a 200 response.
// scanAllShows/resolveGuidsViaBatch never carry a viewCount filter, so
// they always go through the ordinary fetch() transport — mockable here
// without the wire-level complications bug B introduces below.
// ---------------------------------------------------------------------------
describe("bug A — shared MediaContainer item extraction in library.ts", () => {
  const ctx: FetchCtx = {
    connectionUri: "https://plex.example.local:32400",
    token: "test-token",
    clientIdentifier: "test-client",
  };
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses a Metadata-keyed library page (the exact shape that silently produced zero items live)", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            MediaContainer: {
              totalSize: 1,
              Metadata: [{ ratingKey: "10", title: "Show A", leafCount: 5, viewedLeafCount: 5 }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const shows = await scanAllShows(ctx, "3");

    expect(shows).toHaveLength(1);
    expect(shows[0]!.ratingKey).toBe("10");
    expect(shows[0]!.title).toBe("Show A");
  });

  it("resolves guids from a Video-keyed /library/metadata batch response, not only a Metadata-keyed one", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            MediaContainer: { Video: [{ ratingKey: "100", Guid: [{ id: "tmdb://555" }] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const resolved = await resolveGuidsViaBatch(["100"], ctx);

    expect(resolved.get("100")?.tmdbId).toBe(555);
  });
});

// ---------------------------------------------------------------------------
// Bug B — degradation ladder, now with a raw (un-encoded) viewCount filter
// tried first. fetch()/the WHATWG URL parser cannot send a literal `>` in a
// query string (verified in http.test.ts) — it silently re-encodes it — so
// the "raw" ladder rungs go through fetchPlexJsonRawPath's Node
// http/https-module transport instead of fetch(). That means these tests
// need a *real* local HTTP server rather than a mocked global.fetch: a
// fetch mock would never see the raw-rung requests at all, since they never
// call fetch(). Running both transports against one real server is also
// exactly what proves the raw `>=` genuinely reaches the wire, which is the
// point of bug B's fix.
// ---------------------------------------------------------------------------
describe("scanWatchedMovies — degradation ladder (bug B)", () => {
  const ctx: FetchCtx = {
    connectionUri: "",
    token: "test-token",
    clientIdentifier: "test-client",
  };
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** Starts a local HTTP server, points ctx at it, and returns the list of
   *  raw request URLs it received (in order) plus a running count. */
  function startServer(
    handler: (url: string, res: http.ServerResponse) => void,
  ): Promise<{ requestedUrls: string[] }> {
    const requestedUrls: string[] = [];
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        requestedUrls.push(req.url ?? "");
        handler(req.url ?? "", res);
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        ctx.connectionUri = `http://127.0.0.1:${port}`;
        resolve({ requestedUrls });
      });
    });
  }

  function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
  function sendBadRequest(res: http.ServerResponse): void {
    res.writeHead(400);
    res.end("Bad Request");
  }

  it("tries the raw, un-encoded viewCount>=1 filter first — and the literal characters survive to the wire", async () => {
    const { requestedUrls } = await startServer((_url, res) => {
      sendJson(res, {
        MediaContainer: {
          totalSize: 1,
          Video: [{ ratingKey: "1", title: "A", viewCount: 1, Guid: [{ id: "tmdb://1" }] }],
        },
      });
    });

    const result = await scanWatchedMovies(ctx, "1");

    expect(result.variantUsed).toBe("raw-filter");
    expect(result.items).toHaveLength(1);
    // The wire-level proof: a literal ">=" reached the server, not the old
    // %3E%3D encoding and not a silently-re-encoded %3E=.
    expect(requestedUrls[0]).toContain("viewCount>=1");
    expect(requestedUrls[0]).not.toContain("%3E");
  });

  it("falls back to no-includeGuids on a 400 (still raw filter), reports includeGuidsWorked=false, and runs the batched guid fallback", async () => {
    const { requestedUrls } = await startServer((url, res) => {
      if (url.includes("/library/sections/1/all")) {
        if (url.includes("includeGuids=1")) return sendBadRequest(res);
        // Modern-agent item with no Guid children attached (includeGuids
        // didn't work) — needs the batched /library/metadata fallback.
        return sendJson(res, {
          MediaContainer: {
            totalSize: 1,
            Video: [{ ratingKey: "100", title: "Movie A", viewCount: 1, guid: "plex://movie/abc123" }],
          },
        });
      }
      if (url.includes("/library/metadata/100")) {
        return sendJson(res, {
          MediaContainer: { Metadata: [{ ratingKey: "100", Guid: [{ id: "tmdb://555" }] }] },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await scanWatchedMovies(ctx, "1");

    expect(result.includeGuidsWorked).toBe(false);
    expect(result.variantUsed).toBe("raw-filter-no-includeGuids");
    expect(result.items).toHaveLength(1);
    // Proves the batched fallback actually ran and resolved the id.
    expect(result.items[0]!.externalIds.tmdbId).toBe(555);

    expect(requestedUrls.some((u) => u.includes("includeGuids=1"))).toBe(true); // rung 1 was attempted
    expect(requestedUrls.every((u) => !u.includes("/library/sections") || u.includes("viewCount>=1"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("/library/metadata/100"))).toBe(true); // batch fallback ran
  });

  it("falls back from a 1000-item page to a 100-item page on a 400 while keeping the raw filter, reporting variantUsed=raw-filter-size-100", async () => {
    const { requestedUrls } = await startServer((url, res) => {
      if (url.includes("/library/sections/1/all")) {
        if (url.includes("X-Plex-Container-Size=1000")) return sendBadRequest(res);
        // Succeeds at size 100, with or without includeGuids in the query —
        // this server's actual objection is the container size.
        return sendJson(res, {
          MediaContainer: {
            totalSize: 1,
            Video: [{ ratingKey: "200", title: "Movie B", viewCount: 2, Guid: [{ id: "tmdb://42" }] }],
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await scanWatchedMovies(ctx, "1");

    expect(result.variantUsed).toBe("raw-filter-size-100");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.externalIds.tmdbId).toBe(42);

    // Confirms both size=1000 rungs (raw-filter, raw-filter-no-includeGuids)
    // were tried and rejected before landing on size=100 — the ladder
    // didn't skip rungs. (endsWith, not includes: "...Size=1000" also
    // *contains* "...Size=100" as a substring, since "1000" starts with
    // "100".)
    expect(requestedUrls.filter((u) => u.endsWith("X-Plex-Container-Size=1000"))).toHaveLength(2);
    expect(requestedUrls.some((u) => u.endsWith("X-Plex-Container-Size=100"))).toBe(true);
    // All three rungs tried still carried the raw filter.
    expect(requestedUrls.every((u) => u.includes("viewCount>=1"))).toBe(true);
  });

  it("falls back to the %3E%3D-encoded filter (rung 4) when a server specifically rejects the raw form but accepts the encoded one", async () => {
    await startServer((url, res) => {
      if (url.includes("viewCount>=1")) return sendBadRequest(res); // rejects every raw-filter rung
      return sendJson(res, {
        MediaContainer: {
          totalSize: 1,
          Video: [{ ratingKey: "1", title: "A", viewCount: 1, Guid: [{ id: "tmdb://1" }] }],
        },
      });
    });

    const result = await scanWatchedMovies(ctx, "1");

    expect(result.variantUsed).toBe("encoded-filter");
    expect(result.items).toHaveLength(1);
  });

  it("falls through every viewCount-filter wire form to the guaranteed-correct floor when the server rejects the filter outright (live evidence: rungs 1-4 all 400)", async () => {
    await startServer((url, res) => {
      if (url.includes("viewCount")) return sendBadRequest(res); // rejects raw AND encoded
      return sendJson(res, {
        MediaContainer: {
          totalSize: 2,
          Video: [
            { ratingKey: "1", title: "Watched", viewCount: 2, Guid: [{ id: "tmdb://1" }] },
            { ratingKey: "2", title: "Unwatched", viewCount: 0, Guid: [{ id: "tmdb://2" }] },
          ],
        },
      });
    });

    const result = await scanWatchedMovies(ctx, "1");

    expect(result.variantUsed).toBe("no-viewCount-filter");
    // The client-side filter must still drop the unwatched item.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.ratingKey).toBe("1");
  });

  it("does not re-probe the variant on subsequent pages once one has succeeded", async () => {
    const { requestedUrls } = await startServer((url, res) => {
      if (url.includes("/library/sections/1/all")) {
        if (url.includes("includeGuids=1")) return sendBadRequest(res); // every attempt with includeGuids=1 fails
        const start = Number(new URL(url, "http://x").searchParams.get("X-Plex-Container-Start"));
        if (start === 0) {
          return sendJson(res, {
            MediaContainer: {
              totalSize: 2,
              Video: [{ ratingKey: "1", title: "A", viewCount: 1, Guid: [{ id: "tmdb://1" }] }],
            },
          });
        }
        return sendJson(res, {
          MediaContainer: {
            totalSize: 2,
            Video: [{ ratingKey: "2", title: "B", viewCount: 1, Guid: [{ id: "tmdb://2" }] }],
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await scanWatchedMovies(ctx, "1");

    expect(result.items).toHaveLength(2);
    // Page 1: rung 1 (400) + rung 2 (200) = 2 calls. Page 2: exactly 1 more
    // call, reusing the settled raw-filter-no-includeGuids variant — no
    // re-probing.
    expect(requestedUrls.filter((u) => u.includes("/library/sections/1/all"))).toHaveLength(3);
  });

  it("surfaces a clear PlexScanFailedError naming every attempted variant when all rungs 400", async () => {
    await startServer((_url, res) => sendBadRequest(res));

    await expect(scanWatchedMovies(ctx, "1")).rejects.toThrow(PlexScanFailedError);
    await expect(scanWatchedMovies(ctx, "1")).rejects.toThrow(
      /raw-filter, raw-filter-no-includeGuids, raw-filter-size-100, encoded-filter, no-viewCount-filter/,
    );
  });

  it("propagates a non-400 failure immediately without walking the ladder", async () => {
    const { requestedUrls } = await startServer((_url, res) => {
      res.writeHead(401);
      res.end("nope");
    });

    await expect(scanWatchedMovies(ctx, "1")).rejects.toThrow(/401/);
    // Only the first (raw-filter) variant should have been attempted.
    expect(requestedUrls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scanAllMovies — the Phase 6 "discover pool" full-library scan. Reuses the
// same SCAN_VARIANTS/scanAndResolve machinery as the watched-only scans
// above (applyFilter:false), so what needs proving here is specifically:
// (a) it never sends a viewCount filter, on any rung, even as a fallback;
// (b) it returns both watched and unwatched items, unfiltered.
// ---------------------------------------------------------------------------
describe("scanAllMovies — full-library scan (Phase 6 discover pool)", () => {
  const ctx: FetchCtx = {
    connectionUri: "",
    token: "test-token",
    clientIdentifier: "test-client",
  };
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  function startServer(
    handler: (url: string, res: http.ServerResponse) => void,
  ): Promise<{ requestedUrls: string[] }> {
    const requestedUrls: string[] = [];
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        requestedUrls.push(req.url ?? "");
        handler(req.url ?? "", res);
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        ctx.connectionUri = `http://127.0.0.1:${port}`;
        resolve({ requestedUrls });
      });
    });
  }

  function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
  function sendBadRequest(res: http.ServerResponse): void {
    res.writeHead(400);
    res.end("Bad Request");
  }

  it("returns both watched and unwatched movies from a single unfiltered scan", async () => {
    const { requestedUrls } = await startServer((_url, res) => {
      sendJson(res, {
        MediaContainer: {
          totalSize: 2,
          Video: [
            { ratingKey: "1", title: "Watched", viewCount: 3, Guid: [{ id: "tmdb://1" }] },
            { ratingKey: "2", title: "Unwatched", viewCount: 0, Guid: [{ id: "tmdb://2" }] },
          ],
        },
      });
    });

    const result = await scanAllMovies(ctx, "1");

    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.ratingKey).sort()).toEqual(["1", "2"]);
    expect(result.items.find((i) => i.ratingKey === "2")?.viewCount).toBe(0);
    // Never asked the server to filter by viewCount, on the request that
    // actually succeeded.
    expect(requestedUrls[0]).not.toContain("viewCount");
  });

  it("never falls back to a client-side viewCount>=1 refilter, even when every rung is forced down to the floor", async () => {
    // A server that 400s on includeGuids/size=1000 forces the ladder all the
    // way down to its final rung (size=100, no includeGuids) — the exact
    // rung that, for a *watched* scan, would trigger a client-side
    // viewCount>=1 refilter. A full scan must not apply that refilter.
    await startServer((url, res) => {
      if (url.includes("includeGuids=1") || url.includes("X-Plex-Container-Size=1000")) {
        return sendBadRequest(res);
      }
      sendJson(res, {
        MediaContainer: {
          totalSize: 1,
          Video: [{ ratingKey: "5", title: "Unwatched", viewCount: 0, Guid: [{ id: "tmdb://5" }] }],
        },
      });
    });

    const result = await scanAllMovies(ctx, "1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.ratingKey).toBe("5");
  });

  it("paginates a full scan across multiple pages without re-sending a viewCount filter", async () => {
    const { requestedUrls } = await startServer((url, res) => {
      const start = Number(new URL(url, "http://x").searchParams.get("X-Plex-Container-Start"));
      if (start === 0) {
        return sendJson(res, {
          MediaContainer: {
            totalSize: 2,
            Video: [{ ratingKey: "1", title: "A", viewCount: 1, Guid: [{ id: "tmdb://1" }] }],
          },
        });
      }
      return sendJson(res, {
        MediaContainer: {
          totalSize: 2,
          Video: [{ ratingKey: "2", title: "B", viewCount: 0, Guid: [{ id: "tmdb://2" }] }],
        },
      });
    });

    const result = await scanAllMovies(ctx, "1");

    expect(result.items).toHaveLength(2);
    expect(requestedUrls.every((u) => !u.includes("viewCount"))).toBe(true);
  });
});
