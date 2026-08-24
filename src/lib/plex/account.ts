// ---------------------------------------------------------------------------
// Find-or-create by Plex account identity, and the token-linking step that
// follows it. Split out from the route handler (src/app/api/auth/plex/poll)
// so both are unit-testable against a throwaway DB without going through a
// real Next.js request, and so that route stays a thin HTTP-shape wrapper.
//
// Plex is the only identity this app has (see the master plan's "Plex-only
// login" decision) — plex_account_id is therefore the natural find-or-create
// key, not username/email (both of which a Plex account holder can change
// freely; the account id can't). Linking and signing in are the same action
// now, so this module covers what used to be split across signup, login,
// and the separate "link Plex" PIN flow.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plexLinks, users } from "@/db/schema";
import { encryptWithServerVault } from "@/lib/crypto/serverVault";
import type { PlexAccountIdentity } from "./pin";

export type { PlexAccountIdentity };

/** Finds the user row for this Plex account, or creates one. Refreshes the
 *  cached profile fields (username/email/thumb) on every login since Plex
 *  account holders can change any of them — plex_account_id is the only
 *  field this app treats as immutable identity. */
export function findOrCreateUser(identity: PlexAccountIdentity) {
  const existing = db.select().from(users).where(eq(users.plexAccountId, identity.id)).get();
  if (existing) {
    return db
      .update(users)
      .set({ plexUsername: identity.username, plexEmail: identity.email, plexThumb: identity.thumb })
      .where(eq(users.id, existing.id))
      .returning()
      .get();
  }
  return db
    .insert(users)
    .values({
      plexAccountId: identity.id,
      plexUsername: identity.username,
      plexEmail: identity.email,
      plexThumb: identity.thumb,
    })
    .returning()
    .get();
}

/** Encrypts `token` under serverVault and writes plex_links for `userId`.
 *  Always writes key_scope='server' — there is no password any more to
 *  derive a userVault key from (see src/lib/plex/token.ts's file header for
 *  the read side, which still branches on key_scope defensively).
 *
 *  Per Plex constraint 3 (a client identifier, once issued, is persisted
 *  forever — regenerating it creates a new authorized-device entry), a
 *  returning user's already-stored client_identifier is kept as-is rather
 *  than overwritten with `freshClientIdentifier`. That value only exists
 *  because the PIN had to be minted *before* we knew who was signing in
 *  (login is unauthenticated up to this point) — for a brand-new user it
 *  becomes their permanent identifier from here on; for a returning user it
 *  is discarded once we learn their real one. */
export function linkPlexToken(
  userId: string,
  params: { token: string; freshClientIdentifier: string },
): string {
  const tokenCiphertext = encryptWithServerVault(params.token);
  const existing = db.select().from(plexLinks).where(eq(plexLinks.userId, userId)).get();

  if (existing) {
    db.update(plexLinks)
      .set({ tokenCiphertext, keyScope: "server" })
      .where(eq(plexLinks.id, existing.id))
      .run();
    return existing.clientIdentifier;
  }

  db.insert(plexLinks)
    .values({
      userId,
      clientIdentifier: params.freshClientIdentifier,
      tokenCiphertext,
      keyScope: "server",
    })
    .run();
  return params.freshClientIdentifier;
}
