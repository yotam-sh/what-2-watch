import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPlexJson, fetchPlexJsonRawPath, parsePlexBody } from "./http";

describe("parsePlexBody", () => {
  it("parses JSON when Content-Type says json", () => {
    const result = parsePlexBody("application/json", '{"MediaContainer":{"size":1}}') as {
      MediaContainer: { size: number };
    };
    expect(result.MediaContainer.size).toBe(1);
  });

  it("parses JSON even when Content-Type doesn't say json but the body is valid JSON anyway", () => {
    const result = parsePlexBody("text/plain", '{"ok":true}') as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("falls back to XML when the body isn't JSON at all (Accept header ignored by PMS)", () => {
    const xml =
      '<?xml version="1.0"?><MediaContainer size="1"><Video ratingKey="123" title="Foo"><Guid id="tmdb://603"/></Video></MediaContainer>';
    const result = parsePlexBody("text/xml", xml) as {
      MediaContainer: { Video: Array<{ ratingKey: string; title: string; Guid: Array<{ id: string }> }> };
    };
    expect(result.MediaContainer.Video[0].ratingKey).toBe("123");
    expect(result.MediaContainer.Video[0].Guid[0].id).toBe("tmdb://603");
  });

  it("wraps a single XML child element as a one-element array, not a bare object", () => {
    const xml = '<MediaContainer><Directory key="1" title="Movies" type="movie"/></MediaContainer>';
    const result = parsePlexBody("text/xml", xml) as {
      MediaContainer: { Directory: Array<{ key: string }> };
    };
    expect(Array.isArray(result.MediaContainer.Directory)).toBe(true);
    expect(result.MediaContainer.Directory).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bug B — wire-level proof. These spin up a real local HTTP server and
// inspect the raw request line the server actually received (`req.url`),
// rather than mocking global.fetch — mocking fetch only proves what this
// app *intended* to send, not what a URL-parsing layer underneath it might
// silently rewrite. That distinction is the entire bug: `viewCount>=1` was
// always intended, but the wire form is what PMS actually evaluates.
// ---------------------------------------------------------------------------
describe("fetch() vs fetchPlexJsonRawPath — what actually reaches the wire", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  function startEchoServer(): Promise<{ origin: string; requestedUrls: string[] }> {
    const requestedUrls: string[] = [];
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        requestedUrls.push(req.url ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        resolve({ origin: `http://127.0.0.1:${port}`, requestedUrls });
      });
    });
  }

  it("fetchPlexJson (fetch()-based) percent-encodes a literal '>' in the query — it cannot send one raw", async () => {
    const { origin, requestedUrls } = await startEchoServer();

    await fetchPlexJson(`${origin}/library/sections/1/all?type=1&viewCount>=1&sort=lastViewedAt:desc`, {});

    // This is the WHATWG URL Standard's query percent-encode set at work,
    // not a bug in this app's string-building: `>` is always rewritten to
    // %3E when a string URL is handed to fetch(). Confirmed against a real
    // Node http server, not just `new URL()` in isolation.
    expect(requestedUrls[0]).toBe("/library/sections/1/all?type=1&viewCount%3E=1&sort=lastViewedAt:desc");
    expect(requestedUrls[0]).not.toContain("viewCount>=1");
  });

  it("fetchPlexJsonRawPath sends the literal '>=' on the wire, untouched", async () => {
    const { origin, requestedUrls } = await startEchoServer();

    await fetchPlexJsonRawPath(
      origin,
      "/library/sections/1/all?type=1&viewCount>=1&sort=lastViewedAt:desc",
      {},
    );

    expect(requestedUrls[0]).toBe("/library/sections/1/all?type=1&viewCount>=1&sort=lastViewedAt:desc");
    expect(requestedUrls[0]).toContain("viewCount>=1");
    expect(requestedUrls[0]).not.toContain("%3E");
  });
});
