// POST /api/auth/plex/poll — one poll of the in-progress sign-in PIN per
// request, mirroring the old /api/plex/pin/poll's shape (the frontend is
// expected to call this on its own interval, >= 1s per constraint 10,
// rather than this route looping server-side). Unauthenticated: this route
// is what *creates* the session, so it can't require one.
//
// On a claimed token: resolve the Plex account identity → find-or-create the
// user → encrypt the token under serverVault and write plex_links → issue
// the session cookie. Linking and signing in are now the same action — see
// src/lib/plex/account.ts for the find-or-create/link logic this route is a
// thin wrapper around.
import { NextRequest, NextResponse } from "next/server";
import { PLEX_PIN_COOKIE_NAME, readPendingPin } from "@/lib/auth/plexPinCookie";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/cookies";
import { signSessionToken } from "@/lib/auth/jwt";
import { findOrCreateUser, linkPlexToken } from "@/lib/plex/account";
import { getPlexAccountIdentity, pollPin } from "@/lib/plex/pin";

export async function POST(request: NextRequest) {
  const pending = readPendingPin(request);
  if (!pending) {
    return NextResponse.json(
      { error: "No Plex sign-in in progress. Start again." },
      { status: 400 },
    );
  }

  const { authToken } = await pollPin(pending.pinId, pending.code, pending.clientIdentifier);
  if (!authToken) {
    return NextResponse.json({ status: "pending" });
  }

  const identity = await getPlexAccountIdentity(authToken, pending.clientIdentifier);
  const user = findOrCreateUser(identity);
  linkPlexToken(user.id, { token: authToken, freshClientIdentifier: pending.clientIdentifier });

  const token = await signSessionToken({ sub: user.id, username: user.plexUsername });

  const response = NextResponse.json({ status: "linked" });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  response.cookies.delete(PLEX_PIN_COOKIE_NAME);
  return response;
}
