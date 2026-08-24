// ---------------------------------------------------------------------------
// Shared "stub row" helper for the `titles` table.
//
// plex_items.tmdb_id / media_type are nullable specifically so an unresolved
// sync row doesn't violate the composite FK to titles (see schema.ts). But
// watchlist_items' tmdb_id/media_type are NOT NULL, and even a resolved
// plex_items row needs a matching titles row before SQLite's FK enforcement
// (MATCH SIMPLE — any NULL column exempts the row, but non-NULL columns must
// match) will accept it. So both library.ts and discover.ts insert a minimal
// stub titles row (whatever's cheaply available from the Plex item itself)
// before writing anything that references it.
//
// ON CONFLICT DO NOTHING: this never overwrites a titles row Phase 3's TMDB
// enrichment (or a prior Plex sync) already populated with real genres,
// cast, runtime, overview, etc. — it only ever fills in a row that doesn't
// exist yet. Flagged in the Phase 2 report since `titles` is a table Phase 3
// also writes to, even though schema.ts itself is untouched.
// ---------------------------------------------------------------------------

import { db } from "@/db/client";
import { titles } from "@/db/schema";

export async function upsertTitleStub(
  tmdbId: number,
  mediaType: "movie" | "tv",
  title: string,
  year?: number,
): Promise<void> {
  db.insert(titles)
    .values({ tmdbId, mediaType, title: title || `Unknown (${tmdbId})`, year })
    .onConflictDoNothing({ target: [titles.tmdbId, titles.mediaType] })
    .run();
}
