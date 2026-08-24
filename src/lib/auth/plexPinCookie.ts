// ---------------------------------------------------------------------------
// Short-lived, httpOnly cookie carrying an in-progress Plex sign-in PIN's
// id/code/clientIdentifier between POST /api/auth/plex/start and POST
// /api/auth/plex/poll.
//
// Deliberately a cookie, not a server-side map keyed by user/session id like
// the old pinSession.ts: pre-authentication, there IS no user id yet, and
// the only alternative — a map keyed by some placeholder generated at start
// — would just reintroduce, for the *login* flow, the exact "wiped on every
// restart" tradeoff this whole migration exists to eliminate for the
// *session* — for state that only needs to survive the few minutes of the
// PIN's own life, never a server process's uptime. A cookie means the poll
// step works correctly across a restart too, for free, though that's not
// the point here (a few-minute-old PIN flow surviving a restart is a nice
// side effect, not a requirement).
//
// Not signed: the PIN code itself is already Plex's own brute-force-resistant
// secret (`strong=true` in src/lib/plex/pin.ts's createPin), so this cookie
// can only ever echo back exactly what the client itself was handed at
// start — there's no privilege to gain by tampering with it, only the
// ability to poll a PIN you'd already need to know the code for anyway.
// ---------------------------------------------------------------------------

import type { NextRequest } from "next/server";
import { env } from "@/lib/env";

export const PLEX_PIN_COOKIE_NAME = "plex_pin_flow";

export interface PendingPlexPin {
  pinId: number;
  code: string;
  clientIdentifier: string;
}

export function plexPinCookieOptions(expiresInSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.SECURE_COOKIES,
    path: "/",
    maxAge: expiresInSeconds,
  };
}

/** Reads and validates the pending-PIN cookie. Returns null for anything
 *  missing, malformed, or tampered with — same "never throw, let the caller
 *  treat it as a clean slate" shape as verifySessionToken. */
export function readPendingPin(request: NextRequest): PendingPlexPin | null {
  const raw = request.cookies.get(PLEX_PIN_COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<PendingPlexPin>;
    if (
      typeof data.pinId !== "number" ||
      typeof data.code !== "string" ||
      typeof data.clientIdentifier !== "string"
    ) {
      return null;
    }
    return { pinId: data.pinId, code: data.code, clientIdentifier: data.clientIdentifier };
  } catch {
    return null;
  }
}
