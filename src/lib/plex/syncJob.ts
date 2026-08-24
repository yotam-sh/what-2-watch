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
import { getLinkedServerContext, PlexNotLinkedError, PlexUnreachableError } from "@/lib/plex/link";
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

async function runOnce(user: AuthenticatedUser, forceReprobe: boolean, job: SyncJobState) {
  const ctx = await getLinkedServerContext(user, { forceReprobe });
  const libraryResult = await syncLibraries({
    userId: user.id,
    machineIdentifier: ctx.machineIdentifier,
    connectionUri: ctx.connectionUri,
    token: ctx.token,
    clientIdentifier: ctx.clientIdentifier,
  });
  // The library scan is the long pole (~1,900 items); the watchlist is
  // comparatively small. Reported as a distinct phase now that the two run
  // sequentially rather than racing library.ts's own concurrency was for.
  job.phase = "syncing-watchlist";
  const watchlistResult = await syncWatchlist({ userId: user.id, token: ctx.token, clientIdentifier: ctx.clientIdentifier });
  return { libraryResult, watchlistResult };
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
