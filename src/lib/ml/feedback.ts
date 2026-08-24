// ---------------------------------------------------------------------------
// Writes to `interactions` — the ONLY source of training data for cf.ts and
// ltr.ts. Per the master plan: "Every candidate the UI ever surfaces writes
// an interactions row... this must land here [Phase 5]." Kept as its own
// tiny module so both src/app/api/recommend/route.ts (writes 'shown') and
// src/app/api/recommend/feedback/route.ts (writes 'picked'/'skipped'/
// 'snoozed') share one insert path.
// ---------------------------------------------------------------------------

import { db } from "@/db/client";
import { interactions } from "@/db/schema";
import type { MediaType, TitleIdentity } from "./key";

export type FeedbackAction = "picked" | "skipped" | "snoozed";

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
 *  trains on. */
export function recordFeedback(
  userId: string,
  tmdbId: number,
  mediaType: MediaType,
  action: FeedbackAction,
  context?: unknown,
): void {
  db.insert(interactions)
    .values({
      userId,
      tmdbId,
      mediaType,
      action,
      contextJson: context !== undefined ? JSON.stringify(context) : null,
    })
    .run();
}
