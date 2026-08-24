// ---------------------------------------------------------------------------
// Plex Discover watchlist.
//
// CONSTRAINT 14: `discover.provider.plex.tv` inconsistently returns the
// watchlist items under `MediaContainer.Video` instead of the expected
// `MediaContainer.Metadata` — this has broken other projects in production.
// extractMediaContainerItems() below is the one place that guard lives; every
// caller must go through it rather than reading `.Metadata` directly.
//
// Do NOT use `metadata.provider.plex.tv` — deprecated, broke for third
// parties in Oct 2025.
// ---------------------------------------------------------------------------

// NOTE: like library.ts, this file has NO "@/db/client" import — everything
// here is pure or network-only, so pure functions (extractMediaContainerItems
// especially) can be unit-tested without opening the real SQLite database.
// The DB-writing watchlist sync lives in discoverSync.ts.

import { plexHeaders } from "./headers";
import { extractExternalIds, type ExternalIds, type GuidBearingItem } from "./guid";
import { fetchPlexJson } from "./http";
import { coerceArray, coerceInt, coerceString } from "./util";

const DISCOVER_BASE = "https://discover.provider.plex.tv";

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

export interface WatchlistEntry {
  ratingKey: string;
  title: string;
  type: string; // "movie" | "show"
  addedAt: number | undefined; // epoch seconds
}

interface RawWatchlistItem extends GuidBearingItem {
  ratingKey?: unknown;
  title?: unknown;
  type?: unknown;
  addedAt?: unknown;
}

function normalizeWatchlistItem(raw: RawWatchlistItem): WatchlistEntry | null {
  const ratingKey = coerceString(raw.ratingKey);
  if (!ratingKey) return null;
  return {
    ratingKey,
    title: coerceString(raw.title) ?? "",
    type: coerceString(raw.type) ?? "",
    addedAt: coerceInt(raw.addedAt),
  };
}

/** Fetches the account's Plex watchlist. Not unit-tested directly (needs a
 *  live account token) — extractMediaContainerItems above carries the part
 *  of this that's actually fixture-testable. */
export async function fetchWatchlist(token: string, clientIdentifier: string): Promise<WatchlistEntry[]> {
  const body = await fetchPlexJson(
    `${DISCOVER_BASE}/library/sections/watchlist/all`,
    plexHeaders(clientIdentifier, { "X-Plex-Token": token }),
  );
  const container = (body as { MediaContainer?: MediaContainerLike }).MediaContainer;
  const items = extractMediaContainerItems(container) as RawWatchlistItem[];
  return items.map(normalizeWatchlistItem).filter((i): i is WatchlistEntry => i !== null);
}

/** Resolves a single watchlist entry's external ids via its Discover
 *  metadata (`Guid` children) — same modern/legacy defensiveness as the
 *  library sync path, reusing extractExternalIds. */
export async function resolveWatchlistItemGuids(
  ratingKey: string,
  token: string,
  clientIdentifier: string,
): Promise<ExternalIds> {
  const body = await fetchPlexJson(
    `${DISCOVER_BASE}/library/metadata/${ratingKey}`,
    plexHeaders(clientIdentifier, { "X-Plex-Token": token }),
  );
  const container = (body as { MediaContainer?: MediaContainerLike }).MediaContainer;
  const items = extractMediaContainerItems(container) as RawWatchlistItem[];
  const item = items[0];
  return item ? extractExternalIds(item) : { tmdbId: null, imdbId: null, tvdbId: null };
}

/** Maps Plex's watchlist item `type` ("movie" | "show") to the app's
 *  `media_type` ("movie" | "tv"). Anything else (rare, e.g. a Discover
 *  oddity) is treated as unresolvable rather than guessed. Exported for
 *  discoverSync.ts. */
export function toTitlesMediaType(plexType: string): "movie" | "tv" | null {
  if (plexType === "movie") return "movie";
  if (plexType === "show") return "tv";
  return null;
}
