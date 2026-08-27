// ---------------------------------------------------------------------------
// Writes to `interactions` — the ONLY source of training data for cf.ts and
// ltr.ts. Per the master plan: "Every candidate the UI ever surfaces writes
// an interactions row... this must land here [Phase 5]." Kept as its own
// tiny module so both src/app/api/recommend/route.ts (writes 'shown') and
// src/app/api/recommend/feedback/route.ts (writes 'picked'/'skipped'/
// 'snoozed') share one insert path.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { interactions, plexItems } from "@/db/schema";
import type { MediaType, TitleIdentity } from "./key";

export type FeedbackAction = "picked" | "skipped" | "snoozed";

/** Playback state at the instant of a pick, stored inside the interaction's
 *  own context.
 *
 *  WHY A BASELINE IS REQUIRED: a pick can only be judged in hindsight — did
 *  they actually watch the thing? — and hindsight means comparing Plex's
 *  state later against its state now. Without a snapshot, "viewCount is 2"
 *  is unreadable: it could mean they finished it after picking, or it could
 *  have been 2 for a year. The same title can also be picked repeatedly, so
 *  each pick needs its own baseline rather than one per title.
 *
 *  Captured server-side because the browser has no idea what the Plex server
 *  thinks; the client only ever sends {mode, filters}. */
export interface PickBaseline {
  viewCountAtPick: number;
  viewOffsetAtPick: number;
  /** Total runtime in ms, so completion can later be read as a fraction.
   *  Null for titles Plex reports no duration for, and for rows written
   *  before plex_items.duration existed. */
  durationAtPick: number | null;
}

function capturePickBaseline(userId: string, tmdbId: number, mediaType: MediaType): PickBaseline | null {
  const row = db
    .select()
    .from(plexItems)
    .where(and(eq(plexItems.userId, userId), eq(plexItems.tmdbId, tmdbId), eq(plexItems.mediaType, mediaType)))
    .get();
  if (!row) return null; // Letterboxd-only title — nothing on Plex to measure.
  return {
    viewCountAtPick: row.viewCount ?? 0,
    viewOffsetAtPick: row.viewOffset ?? 0,
    durationAtPick: row.duration ?? null,
  };
}

/** Bulk-writes one 'shown' row per candidate, in a single transaction.
 *  Best-effort by design from the caller's perspective — the recommend
 *  route logs and swallows a failure here rather than turning a successful
 *  recommendation into a 500 for the user; a missed 'shown' row just means
 *  slightly less training data, not a broken response. */
export function recordShown(userId: string, candidates: TitleIdentity[], context?: unknown): void {
  if (candidates.length === 0) return;
  const contextJson = context !== undefined ? JSON.stringify(context) : null;
  const now = new Date();
  db.transaction((tx) => {
    for (const c of candidates) {
      tx.insert(interactions)
        .values({ userId, tmdbId: c.tmdbId, mediaType: c.mediaType, action: "shown", contextJson, createdAt: now })
        .run();
    }
  });
}

/** Writes one 'picked'/'skipped'/'snoozed' row — the labeled outcome ltr.ts
 *  trains on.
 *
 *  'picked' additionally carries a playback baseline (see PickBaseline).
 *  'skipped' and 'snoozed' don't need one: they are explicit statements made
 *  by a user looking straight at the title, complete the moment they happen.
 *  'picked' is the only verdict whose truth arrives later — it records the
 *  intention to watch, not the watching. */
export function recordFeedback(
  userId: string,
  tmdbId: number,
  mediaType: MediaType,
  action: FeedbackAction,
  context?: unknown,
): void {
  const baseContext = context !== undefined && context !== null && typeof context === "object" ? context : {};
  const enriched =
    action === "picked"
      ? { ...baseContext, baseline: capturePickBaseline(userId, tmdbId, mediaType) }
      : context;

  db.insert(interactions)
    .values({
      userId,
      tmdbId,
      mediaType,
      action,
      contextJson: enriched !== undefined ? JSON.stringify(enriched) : null,
    })
    .run();
}
