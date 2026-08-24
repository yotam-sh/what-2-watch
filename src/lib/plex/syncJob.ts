// ---------------------------------------------------------------------------
// In-memory background job registry for POST /api/plex/sync.
//
// WHY THIS EXISTS: the first real deployment (TrueNAS behind a Cloudflare
// Tunnel) hit a 502 after 5,680ms on a full-library sync (~1,900 items).
// The container was healthy and the sync had actually succeeded — only the
// HTTP response failed to arrive in time, because the route held one
// request open for the *entire* scan. cloudflared gave up on the origin
// connection before Next.js ever got to send bytes back. This module moves
// that work off the request/response cycle entirely: POST /api/plex/sync
// now only ever starts (or looks up) a job and returns immediately: see
// that route for the thin HTTP adapter around startOrGetSyncJob() below.
//
// IN-MEMORY, LOST ON RESTART — SAME CONVENTION AS postSyncEnrich.ts: `jobs`
// below is a plain module-level Map, nothing more. A container restart
// mid-sync silently drops whatever job was in flight, exactly like
// postSyncEnrich.ts's `running` flag drops an in-flight enrichment pass.
// That's fine, on purpose: the durable record of "did the last sync
// succeed" was never this in-memory job, it's the sync_state row
// (last_run_at / last_error) written by recordSyncState() below — this
// module keeps writing that exactly as the old synchronous route did, so a
// restart still leaves a durable trail even though the live job's progress
// is gone. No jobs table, no persistence, on purpose (see postSyncEnrich.ts
// and backfill.ts's file headers for why this codebase deliberately doesn't
// build that machinery here).
//
// ONE JOB PER USER, keyed by userId. startOrGetSyncJob() returns the
// existing job untouched if one is already `running` for that user, rather
// than launching a second concurrent scan against the same PMS connection
// (which would double every request rate against the user's server for no
// benefit — the first scan already covers everything a second one would).
// ---------------------------------------------------------------------------

import { db } from "@/db/client";
import { syncState } from "@/db/schema";
import type { AuthenticatedUser } from "@/lib/auth/guards";
import { syncWatchlist } from "@/lib/plex/discoverSync";
import { PlexRequestError } from "@/lib/plex/http";
import {
  getLinkedServerContexts,
  PlexNotLinkedError,
  PlexServerSelectionRequiredError,
  PlexUnreachableError,
} from "@/lib/plex/link";
import type { ScanVariantName } from "@/lib/plex/library";
import { syncLibraries } from "@/lib/plex/librarySync";
import { triggerPostSyncEnrichment } from "@/lib/plex/postSyncEnrich";
import { VaultKeyUnavailableError } from "@/lib/plex/token";

const SYNC_SOURCE = "plex";

export type SyncJobStatus = "idle" | "running" | "completed" | "failed";

/** What the job is doing right now, while `status === "running"` — the
 *  "meaningful progress" the status endpoint reports. Coarse-grained by
 *  necessity: syncLibraries()/syncWatchlist() (library.ts's scan ladder)
 *  are not touched by this fix, so progress is phase-level, not a live
 *  per-item counter. */
export type SyncJobPhase = "scanning-library" | "reconnecting" | "syncing-watchlist" | "done";

export interface SyncJobState {
  status: SyncJobStatus;
  phase: SyncJobPhase | null;
  startedAt: string | null;
  completedAt: string | null;
  scanVariant: ScanVariantName | null;
  moviesSynced: number | null;
  showsSynced: number | null;
  libraryItemsSynced: number | null;
  includeGuidsWorked: boolean | null;
  watchlistSynced: number | null;
  watchlistUnresolved: number | null;
  /** Count of selected servers that were skipped this run because their
   *  connection couldn't be resolved (still selected — just unreachable
   *  right now). Null while idle/unknown, 0 once a completed sync reached
   *  every selected server. See getLinkedServerContexts in link.ts. */
  serversUnreachable: number | null;
  error: string | null;
}

function idleState(): SyncJobState {
  return {
    status: "idle",
    phase: null,
    startedAt: null,
    completedAt: null,
    scanVariant: null,
    moviesSynced: null,
    showsSynced: null,
    libraryItemsSynced: null,
    includeGuidsWorked: null,
    watchlistSynced: null,
    watchlistUnresolved: null,
    serversUnreachable: null,
    error: null,
  };
}

/** In-memory only — see file header. Never persisted, never survives a
 *  restart. */
const jobs = new Map<string, SyncJobState>();

/** Tracks the in-flight execution promise per user, purely so tests can
 *  await "this job has settled" deterministically instead of racing a
 *  detached background task — see __waitForSyncJobForTest below. Mirrors
 *  postSyncEnrich.ts's triggerPostSyncEnrichment(), which returns its
 *  promise for the same reason; real callers here still never await it. */
const jobPromises = new Map<string, Promise<void>>();

/** Returns the caller's current job — `idle` if this process has never
 *  tracked one for them (including "a job existed before the last
 *  restart"). Used by both the status route and the sync route's
 *  "return the existing job" path. */
export function getSyncJob(userId: string): SyncJobState {
  return jobs.get(userId) ?? idleState();
}

/** Test-only hook: clears the in-memory registry between tests so state
 *  from one test can't leak into the next (mirrors __setExtractorForTest's
 *  style in embed.ts). */
export function __resetSyncJobsForTest(): void {
  jobs.clear();
  jobPromises.clear();
}

/** Test-only hook: resolves once the given user's currently-tracked job has
 *  settled (completed or failed). Production code never awaits this — the
 *  whole point of startOrGetSyncJob is that it doesn't — but tests need a
 *  deterministic way to observe "the background job finished" instead of
 *  sleeping/polling. Resolves immediately if no job is tracked. */
export function __waitForSyncJobForTest(userId: string): Promise<void> {
  return jobPromises.get(userId) ?? Promise.resolve();
}

function recordSyncState(userId: string, lastError: string | null): void {
  db.insert(syncState)
    .values({ userId, source: SYNC_SOURCE, lastRunAt: new Date(), lastError })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.source],
      set: { lastRunAt: new Date(), lastError },
    })
    .run();
}

type LibraryResult = Awaited<ReturnType<typeof syncLibraries>>;

/** Sums per-server library-scan results across every selected server that
 *  resolved a connection this run. moviesSynced/showsSynced/
 *  libraryItemsSynced are plain counts, so summing is correct; scanVariant/
 *  includeGuidsWorked are per-server characteristics of *which PMS build*
 *  answered, so the first non-null one is kept (mirrors syncLibraries' own
 *  "first section sets it" behavior, just extended across servers). */
function mergeLibraryResults(results: LibraryResult[]): LibraryResult {
  return results.reduce<LibraryResult>(
    (acc, r) => ({
      moviesSynced: acc.moviesSynced + r.moviesSynced,
      showsSynced: acc.showsSynced + r.showsSynced,
      libraryItemsSynced: acc.libraryItemsSynced + r.libraryItemsSynced,
      includeGuidsWorked: acc.includeGuidsWorked ?? r.includeGuidsWorked,
      scanVariant: acc.scanVariant ?? r.scanVariant,
    }),
    { moviesSynced: 0, showsSynced: 0, libraryItemsSynced: 0, includeGuidsWorked: null, scanVariant: null },
  );
}

async function runOnce(user: AuthenticatedUser, forceReprobe: boolean, job: SyncJobState) {
  const { token, clientIdentifier, contexts, unreachable } = await getLinkedServerContexts(user, {
    forceReprobe,
  });

  // One full library scan per selected server, run sequentially rather than
  // concurrently: this app targets a NAS running the PMS itself (see this
  // file's header — the 502-after-5,680ms incident was on exactly that kind
  // of box), and hitting N of a user's servers with N simultaneous
  // ~1,900-item scans is a worse load profile than the current "servers are
  // usually 1" case this codebase has been tuned against. Multi-server
  // accounts pay for it in wall-clock time instead.
  const libraryResults: LibraryResult[] = [];
  for (const ctx of contexts) {
    libraryResults.push(
      await syncLibraries({
        userId: user.id,
        machineIdentifier: ctx.machineIdentifier,
        connectionUri: ctx.connectionUri,
        token: ctx.token,
        clientIdentifier: ctx.clientIdentifier,
      }),
    );
  }
  const libraryResult = mergeLibraryResults(libraryResults);

  // The library scan(s) are the long pole (~1,900 items each); the
  // watchlist is comparatively small and, unlike the library, is an
  // account-level Plex Discover list — not per-server — so it's fetched
  // once regardless of how many servers were just scanned. Reported as a
  // distinct phase now that the two run sequentially rather than racing
  // library.ts's own concurrency was for.
  job.phase = "syncing-watchlist";
  const watchlistResult = await syncWatchlist({ userId: user.id, token, clientIdentifier });
  return { libraryResult, watchlistResult, serversUnreachable: unreachable.length };
}

/** Runs the actual sync end to end and mutates the job object in place as
 *  it goes — never awaited by its caller (startOrGetSyncJob), which is the
 *  entire point: this is the work that used to hold the HTTP response open.
 *  Mirrors the original route's retry-once-on-PlexRequestError and error
 *  classification exactly, just reporting through `job` instead of a
 *  Response. */
async function executeSyncJob(user: AuthenticatedUser, job: SyncJobState): Promise<void> {
  try {
    job.phase = "scanning-library";
    let result;
    try {
      result = await runOnce(user, false, job);
    } catch (err) {
      if (err instanceof PlexRequestError) {
        // Cached connection URI likely went stale (server moved, relay
        // dropped, etc.) — re-race once and try again (constraint 12).
        job.phase = "reconnecting";
        result = await runOnce(user, true, job);
      } else {
        throw err;
      }
    }

    recordSyncState(user.id, null);
    job.status = "completed";
    job.phase = "done";
    job.completedAt = new Date().toISOString();
    job.moviesSynced = result.libraryResult.moviesSynced;
    job.showsSynced = result.libraryResult.showsSynced;
    job.libraryItemsSynced = result.libraryResult.libraryItemsSynced;
    job.includeGuidsWorked = result.libraryResult.includeGuidsWorked;
    job.scanVariant = result.libraryResult.scanVariant;
    job.watchlistSynced = result.watchlistResult.synced;
    job.watchlistUnresolved = result.watchlistResult.unresolved;
    job.serversUnreachable = result.serversUnreachable;

    // Fire-and-forget, exactly as before this fix: kicks off a bounded
    // background enrichment pass so the library self-heals
    // (posters/genres/runtime/embeddings) without a manual backfill.
    // Deliberately not awaited — a background failure there must never
    // turn this already-completed job into a failed one. See
    // postSyncEnrich.ts's file header. Now that this whole function
    // already runs off the request path, there's no response left to
    // protect from *this* await either way, but the job is marked
    // "completed" the moment the sync itself is done rather than waiting
    // on enrichment too — enrichment is a separate, unbounded-duration
    // concern from the user's point of view.
    void triggerPostSyncEnrichment();
  } catch (err) {
    let message: string;
    if (err instanceof PlexNotLinkedError) {
      message = "Plex is not linked.";
      // Not recorded to sync_state: this isn't a sync attempt that failed,
      // it's "there was nothing to sync" — matches the original route,
      // which never called recordSyncState for this error either.
    } else if (err instanceof VaultKeyUnavailableError) {
      message = "Your session expired. Please log in again to sync.";
    } else if (err instanceof PlexServerSelectionRequiredError) {
      message = err.message;
      // Not recorded to sync_state, same rationale as PlexNotLinkedError
      // above: this isn't a failed sync attempt against a known server,
      // it's "there's nothing selected to sync yet" — a state the user
      // resolves in Settings, not by retrying.
    } else if (err instanceof PlexUnreachableError) {
      message = err.message;
      recordSyncState(user.id, message);
    } else {
      message = err instanceof Error ? err.message : "Unknown sync error";
      recordSyncState(user.id, message);
    }
    job.status = "failed";
    job.phase = null;
    job.completedAt = new Date().toISOString();
    job.error = message;
  }
}

/** Starts a background sync job for `user` and returns immediately — never
 *  awaits the scan. If a job is already `running` for this user, returns
 *  that job untouched instead of starting a second one (see file header).
 *  Callers (the sync route) must NOT await the returned promise being
 *  "done" — the job object is mutated in place as executeSyncJob progresses,
 *  and GET /api/plex/sync/status (getSyncJob) is how callers observe that. */
export function startOrGetSyncJob(user: AuthenticatedUser): SyncJobState {
  const existing = jobs.get(user.id);
  if (existing && existing.status === "running") {
    return existing;
  }

  const job: SyncJobState = {
    ...idleState(),
    status: "running",
    phase: "scanning-library",
    startedAt: new Date().toISOString(),
  };
  jobs.set(user.id, job);
  jobPromises.set(user.id, executeSyncJob(user, job));
  return job;
}
