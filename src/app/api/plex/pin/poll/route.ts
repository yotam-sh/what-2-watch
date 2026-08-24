// POST /api/plex/pin/poll — one poll of the in-progress PIN per request.
// The frontend is expected to call this on its own interval (>= 1s, per
// constraint 10) rather than this route looping server-side; that keeps the
// server from ever independently hammering plex.tv on a timer of its own.
// On success, persists plex_links (client_identifier + encrypted token)
// exactly once, atomically — see src/lib/plex/pinSession.ts for why the
// identifier can't be written before this point.
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { plexLinks } from "@/db/schema";
import { getOptionalUser, getVaultKey, requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { encryptWithUserVault } from "@/lib/crypto/userVault";
import { pollPin } from "@/lib/plex/pin";
import { clearPendingPin, getPendingPin } from "@/lib/plex/pinSession";

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    throw err;
  }

  const pending = getPendingPin(user.id);
  if (!pending) {
    return NextResponse.json(
      { error: "No Plex PIN in progress. Start a new one." },
      { status: 400 },
    );
  }

  const { authToken } = await pollPin(pending.pinId, pending.code, pending.clientIdentifier);
  if (!authToken) {
    return NextResponse.json({ status: "pending" });
  }

  const vaultKey = getVaultKey(user.sid);
  if (!vaultKey) {
    // The session's vault key is gone (process restart since login) — we
    // have a real token but can't encrypt it under the userVault scope.
    // Don't lose the pending PIN silently; ask for a fresh login instead.
    return NextResponse.json(
      { error: "Your session expired. Please log in again, then retry linking Plex." },
      { status: 401 },
    );
  }

  const tokenCiphertext = encryptWithUserVault(vaultKey, authToken);
  const existing = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();

  if (existing) {
    db.update(plexLinks)
      .set({ tokenCiphertext, keyScope: "user", clientIdentifier: pending.clientIdentifier })
      .where(eq(plexLinks.id, existing.id))
      .run();
  } else {
    db.insert(plexLinks)
      .values({
        userId: user.id,
        clientIdentifier: pending.clientIdentifier,
        tokenCiphertext,
        keyScope: "user",
      })
      .run();
  }

  clearPendingPin(user.id);

  return NextResponse.json({ status: "linked" });
}

// Also usable read-only for a client that lost its poll loop and just wants
// to know whether *someone else's* concurrent poll already completed it.
export async function GET() {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const pending = getPendingPin(user.id);
  return NextResponse.json({ pending: !!pending });
}
