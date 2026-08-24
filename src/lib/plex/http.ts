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
