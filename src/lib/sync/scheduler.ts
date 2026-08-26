// ---------------------------------------------------------------------------
// The background sync scheduler. One per server process, started from
// src/instrumentation.ts.
//
// WHY THIS CAN EXIST NOW: the master plan ruled background sync out, because
// the Plex token was encrypted under a key derived from the user's password
// and the server literally could not read it while they were logged out.
// Plex-only login (2026-08-24) moved the token to the server key
// (`key_scope: 'server'`), so the server can decrypt it unattended. That
// change is what makes this module possible; if the token ever moves back
// under a user-derived key, Plex auto-sync has to go with it.
//
// RATE LIMITS ARE THE REAL CONSTRAINT. plex.tv 429s are undocumented and a
// hard one often needs a Plex staff manual reset — the single least
// reversible failure in this project. This scheduler therefore does nothing
// clever: it runs rarely, syncs very few users per tick, and rides the
// existing hours-long /api/v2/resources cache rather than widening it. The
// heavy work (library scans) goes to PMS directly, which has no such limit.
// If you tune anything here, tune it *down*.
// ---------------------------------------------------------------------------

import { db } from "@/db/client";
import { plexLinks, syncState } from "@/db/schema";
import { runScheduledLetterboxdSync } from "@/lib/letterboxd/sync";
import { getSyncJob, startOrGetSyncJob } from "@/lib/plex/syncJob";
import { eq } from "drizzle-orm";

/** How often the scheduler wakes up. Not how often anything syncs — each
 *  source has its own interval below, and a tick usually finds nothing due
 *  and goes straight back to sleep. */
const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** How stale a source has to be before it's re-synced. 24h for both Plex and
 *  Letterboxd.
 *
 *  Letterboxd's feed only carries the 50 most recent diary entries and has
 *  no paging, so anything past the 50th between two syncs is lost for good.
 *  A daily sync means that only bites someone who logs 50+ films in a day.
 *
 *  Plex is a full-library scan and far more expensive; watch state doesn't
 *  move fast enough for a shorter interval to change any recommendation. */
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** After a failure, wait this long before retrying rather than hammering a
 *  server that's offline (the overwhelmingly common cause of a failed Plex
 *  sync — a NAS asleep, not a bug). */
const ERROR_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Ceiling on Plex syncs started per tick. A full scan materialises a whole
 *  library section in memory (see PENDING.md), so starting several at once
 *  on a NAS is how this turns into an outage rather than a background job. */
const MAX_PLEX_SYNCS_PER_TICK = 1;

let timer: ReturnType<typeof setInterval> | null = null;

function dueAt(lastRunAt: Date | null, lastError: string | null): number {
  const base = lastRunAt ? lastRunAt.getTime() : 0;
  return base + (lastError ? ERROR_BACKOFF_MS : SYNC_INTERVAL_MS);
}

/** Plex counterpart to runScheduledLetterboxdSync(). Starts (never awaits)
 *  background jobs for users whose last Plex sync has aged out.
 *
 *  Deliberately fire-and-forget: startOrGetSyncJob already owns the job
 *  registry, the phase reporting and the "one job per user" guarantee, so a
 *  tick's only job is to decide *whether* to poke it. Awaiting here would
 *  also mean a slow NAS could hold a tick open past the next one. */
export function runScheduledPlexSync(now: number = Date.now()): string[] {
  const links = db.select().from(plexLinks).all();
  const started: string[] = [];

  for (const link of links) {
    if (started.length >= MAX_PLEX_SYNCS_PER_TICK) break;

    // Never queue behind a sync that's already running — whether this
    // scheduler started it or the user pressed the button ten seconds ago.
    if (getSyncJob(link.userId).status === "running") continue;

    const state = db
      .select()
      .from(syncState)
      .where(eq(syncState.userId, link.userId))
      .all()
      .find((s) => s.source === "plex");

    if (state && now < dueAt(state.lastRunAt, state.lastError)) continue;

    // startOrGetSyncJob wants an AuthenticatedUser, but only reads `id` for
    // scheduling purposes; there is no session here by definition.
    startOrGetSyncJob({ id: link.userId, username: "" });
    started.push(link.userId);
  }

  return started;
}

/** One scheduler pass. Exported for tests and for a manual poke; never
 *  throws — a scheduler that can die on one bad user isn't a scheduler. */
export async function tick(): Promise<void> {
  try {
    runScheduledPlexSync();
  } catch (err) {
    console.error("[scheduler] plex pass failed", err instanceof Error ? err.message : err);
  }

  try {
    await runScheduledLetterboxdSync();
  } catch (err) {
    console.error("[scheduler] letterboxd pass failed", err instanceof Error ? err.message : err);
  }
}

/** Idempotent. Safe to call more than once; only the first call arms it. */
export function startScheduler(): void {
  if (timer) return;

  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);

  // unref so a pending tick can never hold the process open — the container
  // must still be able to exit promptly on SIGTERM during a redeploy.
  timer.unref?.();

  console.log(
    `[scheduler] armed: tick ${TICK_INTERVAL_MS / 60000}m, sync interval ${SYNC_INTERVAL_MS / 3_600_000}h`,
  );
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
