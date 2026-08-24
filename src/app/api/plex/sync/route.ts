// POST /api/plex/sync — runs a full library + watchlist sync for the caller.
// Synchronous for Phase 2 (no background job scheduler yet); acceptable at
// this app's scale per the plan. On a PMS request failure using the cached
// connection URI, re-races the connection once (constraint 12: "re-probe on
// failure") and retries the sync exactly once before giving up.
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { syncState } from "@/db/schema";
import { getOptionalUser } from "@/lib/auth/guards";
import { syncWatchlist } from "@/lib/plex/discoverSync";
import { PlexRequestError } from "@/lib/plex/http";
import { getLinkedServerContext, PlexNotLinkedError, PlexUnreachableError } from "@/lib/plex/link";
import { syncLibraries } from "@/lib/plex/librarySync";
import { triggerPostSyncEnrichment } from "@/lib/plex/postSyncEnrich";
import { VaultKeyUnavailableError } from "@/lib/plex/token";

const SYNC_SOURCE = "plex";

function recordSyncState(userId: string, lastError: string | null): void {
  db.insert(syncState)
    .values({ userId, source: SYNC_SOURCE, lastRunAt: new Date(), lastError })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.source],
      set: { lastRunAt: new Date(), lastError },
    })
    .run();
}

export async function POST() {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const authedUser = user; // narrow once so the closures below see a non-null type

  async function runOnce(forceReprobe: boolean) {
    const ctx = await getLinkedServerContext(authedUser, { forceReprobe });
    const [libraryResult, watchlistResult] = [
      await syncLibraries({
        userId: authedUser.id,
        machineIdentifier: ctx.machineIdentifier,
        connectionUri: ctx.connectionUri,
        token: ctx.token,
        clientIdentifier: ctx.clientIdentifier,
      }),
      await syncWatchlist({ userId: authedUser.id, token: ctx.token, clientIdentifier: ctx.clientIdentifier }),
    ];
    return { libraryResult, watchlistResult };
  }

  try {
    let result;
    try {
      result = await runOnce(false);
    } catch (err) {
      if (err instanceof PlexRequestError) {
        // Cached connection URI likely went stale (server moved, relay
        // dropped, etc.) — re-race once and try again.
        result = await runOnce(true);
      } else {
        throw err;
      }
    }

    recordSyncState(user.id, null);
    // Fire-and-forget: kicks off a bounded background enrichment pass so
    // the library self-heals (posters/genres/runtime/embeddings) without a
    // manual backfill. Deliberately not awaited — see postSyncEnrich.ts's
    // file header for why this must never delay this response or let a
    // background failure surface as a failed sync.
    void triggerPostSyncEnrichment();
    return NextResponse.json({
      ok: true,
      moviesSynced: result.libraryResult.moviesSynced,
      showsSynced: result.libraryResult.showsSynced,
      libraryItemsSynced: result.libraryResult.libraryItemsSynced,
      includeGuidsWorked: result.libraryResult.includeGuidsWorked,
      scanVariant: result.libraryResult.scanVariant,
      watchlistSynced: result.watchlistResult.synced,
      watchlistUnresolved: result.watchlistResult.unresolved,
    });
  } catch (err) {
    if (err instanceof PlexNotLinkedError) {
      return NextResponse.json({ error: "Plex is not linked." }, { status: 400 });
    }
    if (err instanceof VaultKeyUnavailableError) {
      return NextResponse.json(
        { error: "Your session expired. Please log in again to sync." },
        { status: 401 },
      );
    }
    if (err instanceof PlexUnreachableError) {
      recordSyncState(user.id, err.message);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown sync error";
    recordSyncState(user.id, message);
    return NextResponse.json({ error: "Sync failed.", detail: message }, { status: 500 });
  }
}
