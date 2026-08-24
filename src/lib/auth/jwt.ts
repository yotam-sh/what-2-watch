// ---------------------------------------------------------------------------
// Session JWT — signed (not encrypted) with JWT_SECRET. Carries only
// non-sensitive identifiers: user id, username, and a session-store key. The
// userVault encryption key never touches this token — see sessionStore.ts
// for why that split exists.
// ---------------------------------------------------------------------------

import { jwtVerify, SignJWT } from "jose";
import { env } from "@/lib/env";

const ALGORITHM = "HS256";
const EXPIRY = "7d";

export interface SessionTokenPayload {
  sub: string; // user id
  username: string;
  sid: string; // sessionStore.ts key
}

const secretKey = new TextEncoder().encode(env.JWT_SECRET);

export async function signSessionToken(payload: SessionTokenPayload): Promise<string> {
  return new SignJWT({ username: payload.username, sid: payload.sid })
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
    if (
      typeof payload.sub !== "string" ||
      typeof payload.username !== "string" ||
      typeof payload.sid !== "string"
    ) {
      return null;
    }
    return { sub: payload.sub, username: payload.username, sid: payload.sid };
  } catch {
    return null;
  }
}
