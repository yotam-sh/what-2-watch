// ---------------------------------------------------------------------------
// Route/server-component helpers for reading the current session.
//
// getOptionalUser() only needs the session JWT to be valid — it keeps
// working even after a restart wipes the in-memory session store (see
// sessionStore.ts), because user identity (id, username) lives in the JWT
// and the DB, not in the vault-key map.
//
// getVaultKey() additionally needs a live sessionStore entry. It returns
// undefined once that's gone (restart, or a session that was never fully
// established), and callers — e.g. decrypting the Plex token in Phase 2 —
// must treat that as "ask the user to log in again", not a 500.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { SESSION_COOKIE_NAME } from "./cookies";
import { verifySessionToken } from "./jwt";
import { getSessionVaultKey } from "./sessionStore";

export interface AuthenticatedUser {
  id: string;
  username: string;
  /** Session-store key — pass to getVaultKey() to fetch the userVault key. */
  sid: string;
}

/** Thrown by requireUser() when there's no valid session. Callers in route
 *  handlers should catch this and return a 401; callers in server
 *  components should catch it and redirect() to /login. */
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

  return { id: row.id, username: row.username, sid: payload.sid };
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getOptionalUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  return user;
}

/** Looks up the current session's userVault AES key. See file header for
 *  why this can legitimately return undefined for an otherwise-valid user. */
export function getVaultKey(sid: string): Buffer | undefined {
  return getSessionVaultKey(sid);
}
