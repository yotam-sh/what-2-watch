// POST /api/plex/unlink — removes the stored Plex credential so no further
// sync can happen. Deliberately scoped to the credential only: previously
// synced plex_items/watch_events/watchlist_items (encrypted under the
// server-wide vault, not the token itself) are left in place, same as
// Letterboxd data would be after unlinking that source. Full account
// deletion (out of Phase 2 scope) is the mechanism for actually erasing
// history, and cascades from `users` per schema.ts.
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { plexLinks } from "@/db/schema";
import { getOptionalUser } from "@/lib/auth/guards";
import { clearPendingPin } from "@/lib/plex/pinSession";

export async function POST() {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  db.delete(plexLinks).where(eq(plexLinks.userId, user.id)).run();
  clearPendingPin(user.id);

  return NextResponse.json({ ok: true });
}
