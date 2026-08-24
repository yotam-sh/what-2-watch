// ---------------------------------------------------------------------------
// DB-writing orchestration for the watchlist sync — split out from
// discover.ts for the same reason as librarySync.ts/library.ts: keep the
// fixture-testable pure/network logic free of any real DB connection.
// ---------------------------------------------------------------------------

import { db } from "@/db/client";
import { watchlistItems } from "@/db/schema";
import { fetchWatchlist, resolveWatchlistItemGuids, toTitlesMediaType } from "./discover";
import { upsertTitleStub } from "./titlesStub";

/** Full watchlist sync for one user: fetch, resolve each entry's tmdb id via
 *  its Discover metadata, and upsert into watchlist_items. Unlike
 *  plex_items, watchlist_items.tmdb_id/media_type are NOT NULL (schema.ts),
 *  so entries that never resolve to a tmdb id are simply skipped — logged
 *  via the returned `unresolved` count rather than silently dropped. */
export async function syncWatchlist(params: {
  userId: string;
  token: string;
  clientIdentifier: string;
}): Promise<{ synced: number; unresolved: number }> {
  const { userId, token, clientIdentifier } = params;
  const entries = await fetchWatchlist(token, clientIdentifier);

  let synced = 0;
  let unresolved = 0;

  for (const entry of entries) {
    const mediaType = toTitlesMediaType(entry.type);
    if (!mediaType) {
      unresolved += 1;
      continue;
    }
    const ids = await resolveWatchlistItemGuids(entry.ratingKey, token, clientIdentifier);
    if (ids.tmdbId === null) {
      unresolved += 1;
      continue;
    }

    await upsertTitleStub(ids.tmdbId, mediaType, entry.title);

    db.insert(watchlistItems)
      .values({
        userId,
        tmdbId: ids.tmdbId,
        mediaType,
        source: "plex_discover",
        addedAt: entry.addedAt !== undefined ? new Date(entry.addedAt * 1000) : new Date(),
      })
      .onConflictDoNothing({ target: [watchlistItems.userId, watchlistItems.tmdbId, watchlistItems.mediaType] })
      .run();
    synced += 1;
  }

  return { synced, unresolved };
}
