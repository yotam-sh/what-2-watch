"use client";

// ---------------------------------------------------------------------------
// Client-side helper for the backgrounded POST /api/plex/sync +
// GET /api/plex/sync/status pair (see src/lib/plex/syncJob.ts's file header
// for why this is a job instead of one long request: the first real
// deployment 502'd after 5,680ms because the old route held the HTTP
// response open for a full library scan).
//
// The job's shape is duplicated here rather than imported from syncJob.ts —
// same convention as useLinkStatus.ts's PlexLinkStatusResponse/
// LetterboxdLinkStatusResponse types, which mirror their routes' shapes
// rather than importing server-only modules (syncJob.ts transitively pulls
// in @/db/client) into the client bundle.
// ---------------------------------------------------------------------------

import { getJson, postJson } from "./http";

export type SyncJobStatus = "idle" | "running" | "completed" | "failed";
export type SyncJobPhase = "scanning-library" | "reconnecting" | "syncing-watchlist" | "done";

export interface PlexSyncJob {
  status: SyncJobStatus;
  phase: SyncJobPhase | null;
  startedAt: string | null;
  completedAt: string | null;
  scanVariant: string | null;
  moviesSynced: number | null;
  showsSynced: number | null;
  libraryItemsSynced: number | null;
  includeGuidsWorked: boolean | null;
  watchlistSynced: number | null;
  watchlistUnresolved: number | null;
  /** Count of selected servers skipped this run because they couldn't be
   *  reached (still selected — just unreachable right now). Mirrors
   *  SyncJobState.serversUnreachable in src/lib/plex/syncJob.ts. */
  serversUnreachable: number | null;
  error: string | null;
}

export const IDLE_SYNC_JOB: PlexSyncJob = {
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

/** How often the browser polls GET /api/plex/sync/status while a sync is
 *  running. That endpoint just reads an in-memory map (syncJob.ts) — there's
 *  no external rate limit to respect here (unlike plex.tv PIN polling's
 *  MIN_POLL_INTERVAL_MS in pinFlow.ts). 2s is a plain UX/load balance: a
 *  full ~1,900-item library scan runs for anywhere from several seconds to
 *  a couple of minutes, so sub-second responsiveness buys nothing, while a
 *  much longer interval would make the "Syncing... (scanning library)"
 *  status feel stuck. This keeps status polling to well under one request
 *  per second on a NAS that may already be busy running the sync itself. */
export const SYNC_POLL_INTERVAL_MS = 2000;

export function startPlexSync() {
  return postJson<PlexSyncJob>("/api/plex/sync");
}

export function getPlexSyncStatus() {
  return getJson<PlexSyncJob>("/api/plex/sync/status");
}

export function isSyncSettled(job: PlexSyncJob): boolean {
  return job.status === "completed" || job.status === "failed";
}

/** Human-readable label for whatever the job is doing right now — used by
 *  both SettingsScreen and SyncButton so the two don't drift. */
export function describeSyncPhase(job: PlexSyncJob): string {
  switch (job.phase) {
    case "scanning-library":
      return "Scanning your Plex library...";
    case "reconnecting":
      return "Reconnecting to your Plex server...";
    case "syncing-watchlist":
      return "Syncing your watchlist...";
    case "done":
      return "Finishing up...";
    default:
      return "Syncing...";
  }
}

/** Polls GET /api/plex/sync/status every SYNC_POLL_INTERVAL_MS until the job
 *  settles (`completed` or `failed`), invoking `onUpdate` with each observed
 *  state along the way (including the first one, synchronously-ish, so
 *  callers can render "running" immediately rather than waiting a full
 *  interval). Resolves with the final settled job.
 *
 *  A transient network hiccup on the status GET itself does NOT stop
 *  polling — the sync job running server-side is unaffected by one dropped
 *  status check, so retrying is correct. A 401 is different: the session is
 *  gone, so no future poll can ever succeed either — that resolves
 *  immediately with a synthetic failed job instead of polling forever. */
export function pollPlexSyncUntilSettled(onUpdate?: (job: PlexSyncJob) => void): Promise<PlexSyncJob> {
  return new Promise((resolve) => {
    async function poll() {
      const result = await getPlexSyncStatus();
      if (result.status === 401) {
        const failed: PlexSyncJob = { ...IDLE_SYNC_JOB, status: "failed", error: "Not signed in." };
        onUpdate?.(failed);
        resolve(failed);
        return;
      }
      if (result.data) {
        onUpdate?.(result.data);
        if (isSyncSettled(result.data)) {
          resolve(result.data);
          return;
        }
      }
      setTimeout(() => void poll(), SYNC_POLL_INTERVAL_MS);
    }
    void poll();
  });
}

/** Starts (or joins) a sync job and polls it to completion — the shape both
 *  SettingsScreen and SyncButton want: kick it off, watch progress, get the
 *  final state back. */
export async function runPlexSync(onUpdate?: (job: PlexSyncJob) => void): Promise<PlexSyncJob> {
  const started = await startPlexSync();
  if (started.status === 401) {
    const failed: PlexSyncJob = { ...IDLE_SYNC_JOB, status: "failed", error: "Not signed in." };
    onUpdate?.(failed);
    return failed;
  }
  if (started.data) {
    onUpdate?.(started.data);
    if (isSyncSettled(started.data)) {
      return started.data;
    }
  }
  return pollPlexSyncUntilSettled(onUpdate);
}
