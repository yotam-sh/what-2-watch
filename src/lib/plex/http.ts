// ---------------------------------------------------------------------------
// Low-level HTTP helper shared by every Plex module that talks to plex.tv,
// Discover, or a PMS: fetch + parse, with a defensive fallback to XML.
//
// `Accept: application/json` works against PMS, but constraint 8 warns some
// endpoints/builds ignore it. Rather than trust the Accept header, we sniff
// the actual Content-Type of the response and fall back to parsing the body
// as XML (via fast-xml-parser) if it isn't JSON — and even then, we still
// try JSON first regardless of the declared Content-Type, since a
// mislabeled-but-actually-JSON response is cheaper to detect than to miss.
// ---------------------------------------------------------------------------

import http from "node:http";
import https from "node:https";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "_text",
  // Plex/PMS XML always represents child elements as repeatable tags
  // (<Video/>, <Guid/>, ...); without this every "exactly one child" case
  // would parse as a bare object instead of a one-element array, which is
  // exactly the ambiguity coerceArray() exists to paper over — but telling
  // fast-xml-parser to always produce arrays for these tags removes the
  // ambiguity at the source for the XML path specifically.
  isArray: (tagName) => ["Video", "Directory", "Guid", "Media", "Part"].includes(tagName),
});

export class PlexRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "PlexRequestError";
  }
}

/** Pure parsing step, deliberately split from fetchPlexJson so it can be
 *  unit-tested with fixture strings instead of a live Response. */
export function parsePlexBody(contentType: string, bodyText: string): unknown {
  const looksJson = contentType.includes("json");
  if (looksJson) {
    return JSON.parse(bodyText);
  }
  // Content-Type lied or was absent — try JSON anyway before falling back to
  // XML, since some PMS builds return valid JSON under a text/plain header.
  try {
    return JSON.parse(bodyText);
  } catch {
    return xmlParser.parse(bodyText);
  }
}

/** Fetches a Plex/PMS/Discover URL and returns the parsed body (JSON or, on
 *  fallback, XML normalized into the same shape fast-xml-parser produces).
 *  Not unit-tested directly — it needs a live Plex endpoint; parsePlexBody
 *  above carries all the parsing logic that *can* be tested with fixtures. */
export async function fetchPlexJson(
  url: string,
  headers: Record<string, string>,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new PlexRequestError(`Plex request failed (${res.status}): ${url}`, res.status, url);
  }
  const contentType = res.headers.get("content-type") ?? "";
  return parsePlexBody(contentType, bodyText);
}

// ---------------------------------------------------------------------------
// Bug B: fetch() cannot send a literal, un-encoded `>` in a query string.
//
// fetch()/Request always route a string URL through the WHATWG URL parser,
// and the URL Standard's "query percent-encode set" includes `<` and `>` —
// so `new URL("...?viewCount>=1")` unconditionally rewrites that to
// `...?viewCount%3E=1` when it serializes the request. This was verified
// empirically against a real Node http server capturing the raw request
// line: a string built with a bare `>` still arrives on the wire percent-
// encoded. There is no fetch()-level option to suppress this — it's
// mandated by the spec's serializer, not an encodeURIComponent() call this
// app controls.
//
// `viewCount>=1`'s `>` needs to survive completely untouched for PMS's own
// filter-query parsing to recognize it (see library.ts's ladder rung 1-3).
// The only way to guarantee that is to skip the URL object entirely and
// hand Node's http/https module a pre-built path string, which is written
// to the socket byte-for-byte with no re-encoding pass.
// ---------------------------------------------------------------------------

/** Like fetchPlexJson, but issues the request via Node's http/https module
 *  directly instead of fetch(), so `pathWithQuery` reaches the server
 *  exactly as given — no WHATWG URL re-encoding of characters like `>`.
 *  `origin` is parsed only for protocol/host/port; it never touches
 *  `pathWithQuery`. Not used for the general case (fetchPlexJson above
 *  covers everything else) — only where a literal character in the query
 *  must survive to the wire untouched. */
export async function fetchPlexJsonRawPath(
  origin: string,
  pathWithQuery: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const originUrl = new URL(origin);
  const client = originUrl.protocol === "https:" ? https : http;
  const port = originUrl.port || (originUrl.protocol === "https:" ? 443 : 80);

  const { status, contentType, text } = await new Promise<{ status: number; contentType: string; text: string }>(
    (resolve, reject) => {
      const req = client.request(
        {
          hostname: originUrl.hostname,
          port,
          path: pathWithQuery,
          method: "GET",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              contentType: res.headers["content-type"] ?? "",
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    },
  );

  const url = `${origin}${pathWithQuery}`;
  if (status < 200 || status >= 300) {
    throw new PlexRequestError(`Plex request failed (${status}): ${url}`, status, url);
  }
  return parsePlexBody(contentType, text);
}
