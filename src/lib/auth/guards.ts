// ---------------------------------------------------------------------------
// Route/server-component helpers for reading the current session.
//
// Plex-only login (revised 2026-08-24): getOptionalUser() used to be the
// "survives a restart" half of a two-part session (see the old sessionStore
// getVaultKey() companion, now deleted) — now it's the *whole* session. The
// Plex token lives under serverVault, not a per-session key, so there is
// nothing left that a restart can invalidate: as long as the JWT cookie
// verifies and the user row still exists, the caller is fully authenticated,
// full stop.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { SESSION_COOKIE_NAME } from "./cookies";
import { verifySessionToken } from "./jwt";

export interface AuthenticatedUser {
  id: string;
  username: string;
}

/** Thrown by requireUser() when there's no valid session. Callers in route
 *  handlers should catch this and return a 401; callers in server
 *  components should catch it and redirect() to the landing page ("/"). */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "UnauthenticatedError";
  }
}

export async function getOptionalUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload) return null;

  // Confirm the user row still exists — e.g. wasn't deleted since the token
  // was issued — rather than trusting the JWT's claims blindly.
  const row = db.select().from(users).where(eq(users.id, payload.sub)).get();
  if (!row) return null;

  return { id: row.id, username: row.plexUsername };
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getOptionalUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  return user;
}
