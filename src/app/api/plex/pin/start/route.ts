// POST /api/plex/pin/start — mints a Plex PIN and returns the app.plex.tv
// auth URL for the frontend to redirect/open. Reuses the user's existing
// plex_links.client_identifier if they have one (constraint 3: never
// regenerate it for an already-linked user); otherwise mints a fresh one
// held in-memory until the poll route sees a claimed token (see
// src/lib/plex/pinSession.ts for why it can't go straight into the DB).
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { plexLinks } from "@/db/schema";
import { getClientIp } from "@/lib/auth/clientIp";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { SlidingWindowRateLimiter } from "@/lib/auth/rateLimit";
import { buildAuthUrl, createPin } from "@/lib/plex/pin";
import { generateClientIdentifier } from "@/lib/plex/headers";
import { setPendingPin } from "@/lib/plex/pinSession";

// Independent from every other rate limiter per the plan ("rate-limit
// signup, login, and PIN creation independently").
const pinLimiter = new SlidingWindowRateLimiter(5, 60_000);

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    throw err;
  }

  if (!pinLimiter.check(getClientIp(request))) {
    return NextResponse.json(
      { error: "Too many PIN requests. Please try again in a minute." },
      { status: 429 },
    );
  }

  let forwardUrl: string;
  try {
    const body = (await request.json().catch(() => ({}))) as { forwardUrl?: unknown };
    const origin = request.nextUrl.origin;
    forwardUrl = typeof body.forwardUrl === "string" ? body.forwardUrl : `${origin}/settings/plex`;
  } catch {
    forwardUrl = `${request.nextUrl.origin}/settings/plex`;
  }

  const existingLink = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();
  const clientIdentifier = existingLink?.clientIdentifier ?? generateClientIdentifier();

  const pin = await createPin(clientIdentifier);
  setPendingPin(user.id, {
    pinId: pin.id,
    code: pin.code,
    clientIdentifier,
    createdAt: Date.now(),
  });

  const authUrl = buildAuthUrl({ clientIdentifier, code: pin.code, forwardUrl });

  return NextResponse.json({ authUrl, expiresIn: pin.expiresIn });
}
