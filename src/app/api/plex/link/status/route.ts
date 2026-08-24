// GET /api/plex/link/status — reports whether the caller has a linked Plex
// account, without ever returning the token itself (constraint 11: it must
// never reach the browser).
//
// "hasConnection"/"connectionCheckedAt" used to read straight off plex_links
// (one cached connection, one server). Now that connection caching is
// per-selected-server (plex_selected_servers — see the server picker's
// schema.ts doc comment), these are aggregates: hasConnection is true if ANY
// selected server has a confirmed connection, and connectionCheckedAt is the
// most recent of them. Good enough for this endpoint's job (a coarse
// "has syncing ever worked" signal for DecideScreen's empty states) — the
// full per-server picture (which ones, owned vs shared, reachable right now)
// is GET /api/plex/servers, not this route.
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { plexLinks, plexSelectedServers } from "@/db/schema";
import { getOptionalUser } from "@/lib/auth/guards";

export async function GET() {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const link = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();
  if (!link) {
    return NextResponse.json({ linked: false });
  }

  const selected = db
    .select()
    .from(plexSelectedServers)
    .where(eq(plexSelectedServers.userId, user.id))
    .all();
  const hasConnection = selected.some((s) => s.cachedConnectionUri !== null);
  const connectionCheckedAt = selected.reduce<Date | null>((latest, s) => {
    if (!s.connectionCheckedAt) return latest;
    if (!latest || s.connectionCheckedAt.getTime() > latest.getTime()) return s.connectionCheckedAt;
    return latest;
  }, null);

  return NextResponse.json({
    linked: true,
    selectedServerCount: selected.length,
    hasConnection,
    connectionCheckedAt,
    keyScope: link.keyScope,
  });
}
