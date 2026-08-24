// ---------------------------------------------------------------------------
// In-memory session store — maps a session id (embedded in the session JWT
// as `sid`) to the userVault AES key derived at login/signup time.
//
// Why the vault key isn't just embedded in the JWT: the JWT lives in an
// httpOnly cookie, but "httpOnly" only blocks JS access to it — the cookie
// is still plaintext in transit/log capture, and a cookie-theft or
// session-fixation bug would then hand over a real *encryption key*, not
// just an opaque bearer token. Keeping the key server-side and in-memory
// only means a stolen cookie is useless without the matching in-process
// entry.
//
// DELIBERATE CONSEQUENCE: sessions do not survive a process/container
// restart. This is accepted, not a bug — it's the direct cost of deriving
// a real encryption key from the user's password instead of a static server
// secret (that's the entire privacy property this app is built around: the
// server cannot decrypt a Plex token while its owner is logged out). After a
// restart, the JWT cookie itself is still valid — see jwt.ts — so
// getOptionalUser() keeps working and the user stays "logged in" for
// browsing purposes; only getVaultKey() goes empty, and anything that needs
// it (decrypting the Plex token in Phase 2) must prompt a re-login rather
// than 500.
//
// This is intentionally the only module that knows sessions live in memory
// — swapping to Redis/etc. later is a change to this one file.
// ---------------------------------------------------------------------------

interface SessionRecord {
  userId: string;
  vaultKey: Buffer;
  createdAt: number;
}

const sessions = new Map<string, SessionRecord>();

/** Creates a new session entry and returns its id. Call at signup/login,
 *  after the vault key has been derived. */
export function createSession(userId: string, vaultKey: Buffer): string {
  const sid = crypto.randomUUID();
  sessions.set(sid, { userId, vaultKey, createdAt: Date.now() });
  return sid;
}

/** Returns the vault key for a session id, or undefined if the session
 *  doesn't exist (never created, already destroyed, or lost to a restart). */
export function getSessionVaultKey(sid: string): Buffer | undefined {
  return sessions.get(sid)?.vaultKey;
}

/** Removes a session — call on logout. */
export function destroySession(sid: string): void {
  sessions.delete(sid);
}

/** Test/diagnostic helper — not used by app code. */
export function _sessionCount(): number {
  return sessions.size;
}
