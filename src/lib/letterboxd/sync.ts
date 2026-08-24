// ---------------------------------------------------------------------------
// DB-writing orchestration for Letterboxd sync — split from rss.ts for the
// same reason Phase 2 split library.ts/librarySync.ts: rss.ts stays pure and
// network-free so it's fully unit-tested against fixtures; this file needs a
// real SQLite connection to exercise and isn't unit-tested directly.
//
// Session-gating: the plan's general privacy rule is "background sync only
// runs for users with an active session, unless they've opted into the
// server-key re-wrap" (see plex_links.key_scope). That rule exists because a
// Plex token is a full-account credential that can only be decrypted with a
// key derived from the user's password (the userVault scope), which isn't
// available without a live session. Letterboxd has no such secret —
// `letterboxd_links.username` is public information (it's literally the URL
// path segment for an unauthenticated RSS feed) and is stored in plain text,
// not under either vault scope. There is therefore nothing here a live
// session is protecting, and `runScheduledLetterboxdSync` deliberately does
// NOT gate on session state — every linked user is eligible for background
// polling. (See the Phase 3 report for the plain-text-username decision.)
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { letterboxdLinks, syncState, watchEvents } from "@/db/schema";
import { enrichTitle, ensureTitleStub } from "@/lib/tmdb/store";
import {
  fetchLetterboxdRssXml,
  LetterboxdFetchError,
  LetterboxdUserNotFoundError,
  parseLetterboxdRss,
  selectNewEntries,
  type LetterboxdDiaryEntry,
} from "./rss";

const SYNC_SOURCE = "letterboxd";
// "Daily is ample" per the plan — the 50-entry cap only bites for someone
// logging 50+ films between polls.
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class LetterboxdNotLinkedError extends Error {
  constructor() {
    super("No Letterboxd account linked.");
    this.name = "LetterboxdNotLinkedError";
  }
}

export interface LetterboxdSyncResult {
  username: string;
  newEntries: number;
}

function getLink(userId: string) {
  return db.select().from(letterboxdLinks).where(eq(letterboxdLinks.userId, userId)).get();
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

/** Validates + persists a Letterboxd link. Fetches the feed once up front —
 *  both to verify the account actually exists (turning a typo into an
 *  immediate 404-mapped error instead of a link that will never sync) and
 *  because that same fetch feeds the initial sync the caller almost always
 *  wants to run right after linking. Throws InvalidLetterboxdUsernameError /
 *  LetterboxdUserNotFoundError / LetterboxdFetchError from rss.ts. */
export async function linkLetterboxdAccount(userId: string, username: string): Promise<void> {
  await fetchLetterboxdRssXml(username); // validates username + confirms the account exists

  db.insert(letterboxdLinks)
    .values({ userId, username })
    .onConflictDoUpdate({
      target: letterboxdLinks.userId,
      // Re-linking (e.g. a corrected username) resets the guid high-water
      // mark: the new account has its own, unrelated guid space.
      set: { username, lastGuidSeen: null, lastPolledAt: null },
    })
    .run();
}

export function unlinkLetterboxdAccount(userId: string): void {
  db.delete(letterboxdLinks).where(eq(letterboxdLinks.userId, userId)).run();
}

export function getLetterboxdSyncStatus(userId: string) {
  const link = getLink(userId);
  if (!link) return { linked: false as const };

  const state = db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, userId), eq(syncState.source, SYNC_SOURCE)))
    .get();

  return {
    linked: true as const,
    username: link.username,
    lastPolledAt: link.lastPolledAt,
    lastRunAt: state?.lastRunAt ?? null,
    lastError: state?.lastError ?? null,
  };
}

/** Fetches, dedupes against the stored guid high-water mark, and writes new
 *  diary entries as `watch_events` for one user — the whole write (title
 *  stubs, watch_events, the new high-water mark, and the sync_state success
 *  record) happens inside a single transaction, so a crash partway through
 *  never leaves `last_guid_seen` pointing past events that were never
 *  actually written (which would silently drop them on the next poll).
 *
 *  TMDB enrichment for newly-seen titles runs afterward, best-effort, one
 *  title at a time — a TMDB failure (e.g. the placeholder dev key) must
 *  never fail the Letterboxd sync itself, only leave that title as an
 *  unenriched stub for a later retry. */
export async function syncLetterboxdForUser(userId: string): Promise<LetterboxdSyncResult> {
  const link = getLink(userId);
  if (!link) throw new LetterboxdNotLinkedError();

  let entries: LetterboxdDiaryEntry[];
  try {
    const xml = await fetchLetterboxdRssXml(link.username);
    entries = parseLetterboxdRss(xml);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Letterboxd fetch error";
    recordSyncState(userId, message);
    throw err;
  }

  const fresh = selectNewEntries(entries, link.lastGuidSeen);
  const oldestFirst = [...fresh].reverse();

  db.transaction((tx) => {
    for (const entry of oldestFirst) {
      ensureTitleStub(entry.tmdbId, entry.mediaType, entry.filmTitle, entry.filmYear, tx);
      tx.insert(watchEvents)
        .values({
          userId,
          tmdbId: entry.tmdbId,
          mediaType: entry.mediaType,
          source: SYNC_SOURCE,
          watchedAt: entry.watchedDate,
          rating: entry.memberRating ?? null,
          isRewatch: entry.isRewatch,
        })
        .run();
    }

    // fresh[0] is the newest of the new entries (feed order is newest-first
    // and selectNewEntries preserves that), so it's the correct new
    // high-water mark. If nothing was new, leave last_guid_seen untouched.
    tx.update(letterboxdLinks)
      .set({
        lastPolledAt: new Date(),
        ...(fresh.length > 0 ? { lastGuidSeen: fresh[0]!.guid } : {}),
      })
      .where(eq(letterboxdLinks.userId, userId))
      .run();

    tx.insert(syncState)
      .values({ userId, source: SYNC_SOURCE, lastRunAt: new Date(), lastError: null })
      .onConflictDoUpdate({
        target: [syncState.userId, syncState.source],
        set: { lastRunAt: new Date(), lastError: null },
      })
      .run();
  });

  for (const entry of fresh) {
    try {
      await enrichTitle(entry.tmdbId, entry.mediaType);
    } catch {
      // Best-effort — see file header. The stub row ensureTitleStub already
      // wrote inside the transaction above stands in until a later retry
      // (e.g. the next sync's enrichment pass, since enrichTitle no-ops once
      // a title is genuinely enriched but retries freely on a bare stub).
    }
  }

  return { username: link.username, newEntries: fresh.length };
}

export interface BatchSyncResult {
  userId: string;
  ok: boolean;
  newEntries?: number;
  error?: string;
}

/** Entry point for a scheduler (cron, setInterval, etc. — wiring one up is
 *  left to a later phase; this is the function it should call). Syncs every
 *  linked user whose last poll is more than a day old, per-user, and never
 *  lets one user's failure abort the batch. */
export async function runScheduledLetterboxdSync(): Promise<BatchSyncResult[]> {
  const links = db.select().from(letterboxdLinks).all();
  const now = Date.now();
  const results: BatchSyncResult[] = [];

  for (const link of links) {
    const lastPolledMs = link.lastPolledAt ? link.lastPolledAt.getTime() : 0;
    if (now - lastPolledMs < POLL_INTERVAL_MS) continue;

    try {
      const result = await syncLetterboxdForUser(link.userId);
      results.push({ userId: link.userId, ok: true, newEntries: result.newEntries });
    } catch (err) {
      results.push({
        userId: link.userId,
        ok: false,
        error: err instanceof Error ? err.message : "Unknown sync error",
      });
    }
  }

  return results;
}

export { LetterboxdFetchError, LetterboxdUserNotFoundError };
