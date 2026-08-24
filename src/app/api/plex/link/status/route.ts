// GET /api/plex/link/status — reports whether the caller has a linked Plex
// account, without ever returning the token itself (constraint 11: it must
// never reach the browser).
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { plexLinks } from "@/db/schema";
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

  return NextResponse.json({
    linked: true,
    machineIdentifier: link.machineIdentifier,
    hasConnection: !!link.cachedConnectionUri,
    connectionCheckedAt: link.connectionCheckedAt,
    keyScope: link.keyScope,
  });
}
