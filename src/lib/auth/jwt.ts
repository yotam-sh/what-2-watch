// ---------------------------------------------------------------------------
// Session JWT — signed (not encrypted) with JWT_SECRET. Carries only
// non-sensitive identifiers: user id and username.
//
// Plex-only login (revised 2026-08-24): there is no vault key to carry
// alongside identity any more. The old `sid` claim existed purely to key the
// in-memory userVault session store (sessionStore.ts, now deleted) — with
// the Plex token encrypted under serverVault instead, nothing needs a
// live-session-only secret, so the JWT is now the *entire* session. That's
// also what makes sessions survive a container restart: this token alone is
// sufficient to re-establish identity, with no in-memory side table that a
// restart could wipe.
// ---------------------------------------------------------------------------

import { jwtVerify, SignJWT } from "jose";
import { env } from "@/lib/env";

const ALGORITHM = "HS256";
const EXPIRY = "7d";

export interface SessionTokenPayload {
  sub: string; // user id
  username: string;
}

const secretKey = new TextEncoder().encode(env.JWT_SECRET);

export async function signSessionToken(payload: SessionTokenPayload): Promise<string> {
  return new SignJWT({ username: payload.username })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(secretKey);
}

/** Verifies and decodes a session token. Returns null (never throws) on any
 *  invalid/expired/malformed token so callers can treat that uniformly as
 *  "not logged in". */
export async function verifySessionToken(token: string): Promise<SessionTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: [ALGORITHM] });
    if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
      return null;
    }
    return { sub: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}
