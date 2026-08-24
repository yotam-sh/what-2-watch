// ---------------------------------------------------------------------------
// Shared MediaContainer item extraction.
//
// CONSTRAINT 14: Plex inconsistently returns list items under
// `MediaContainer.Metadata`, `.Video`, or `.Directory` depending on the
// endpoint and server build. This has broken multiple projects in
// production — including this one: bug A was library.ts's paged library
// scan reading only `.Video ?? .Directory`, so a PMS build that returned
// `.Metadata` produced a silent, error-free zero-item result (HTTP 200,
// `coerceArray` on `undefined` yields `[]`, nothing ever throws).
//
// extractMediaContainerItems() below is the one place this guard lives —
// every caller (library.ts's page scan, its batched guid-resolution
// response, discover.ts's watchlist calls, ...) must go through it rather
// than reading `.Metadata`/`.Video`/`.Directory` directly.
// ---------------------------------------------------------------------------

import { coerceArray } from "./util";

export interface MediaContainerLike {
  Metadata?: unknown[] | unknown;
  Video?: unknown[] | unknown;
  Directory?: unknown[] | unknown;
}

/** CONSTRAINT 14's guard, isolated as a pure function so it's directly unit
 *  testable: `Metadata ?? Video ?? Directory ?? []`, in that order, with
 *  none of the three assumed present. */
export function extractMediaContainerItems(container: MediaContainerLike | null | undefined): unknown[] {
  if (!container) return [];
  if (container.Metadata !== undefined) return coerceArray(container.Metadata);
  if (container.Video !== undefined) return coerceArray(container.Video);
  if (container.Directory !== undefined) return coerceArray(container.Directory);
  return [];
}
