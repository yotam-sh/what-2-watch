// ---------------------------------------------------------------------------
// Loads a user's plex_links row, decrypts the token, and resolves a live PMS
// connection URI — the shared setup every route that actually talks to a
// user's PMS (sync, image proxy) needs. Centralizing it means the
// re-probe-on-failure behavior (constraint 12) and the key_scope handling
// only have to be right once.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plexLinks } from "@/db/schema";
import { getVaultKey } from "@/lib/auth/guards";
import { getPlexServers, resolveServerConnection } from "./resources";
import { decryptPlexToken } from "./token";

export class PlexNotLinkedError extends Error {
  constructor() {
    super("No Plex account linked");
    this.name = "PlexNotLinkedError";
  }
}

export class PlexUnreachableError extends Error {
  constructor() {
    super("Could not reach the linked Plex server on any known connection");
    this.name = "PlexUnreachableError";
  }
}

export interface LinkedServerContext {
  linkId: string;
  machineIdentifier: string;
  token: string;
  clientIdentifier: string;
  connectionUri: string;
}

/** Loads the caller's plex_links row, decrypts the token per key_scope, and
 *  resolves a working PMS connection URI — reusing the cached one if fresh,
 *  re-racing (and persisting the new winner) otherwise. Pass
 *  `forceReprobe: true` after an actual PMS call using the cached URI has
 *  failed, per constraint 12. */
export async function getLinkedServerContext(
  user: { id: string; sid: string },
  opts: { forceReprobe?: boolean } = {},
): Promise<LinkedServerContext> {
  const link = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();
  if (!link) {
    throw new PlexNotLinkedError();
  }

  const vaultKey = getVaultKey(user.sid);
  const token = decryptPlexToken({
    keyScope: link.keyScope,
    tokenCiphertext: link.tokenCiphertext,
    vaultKey,
  });

  let machineIdentifier = link.machineIdentifier;
  if (!machineIdentifier) {
    // First-ever connection for this link: discover the account's servers
    // and pick one. Prefer an owned server (the common case: the user's own
    // Plex Media Server) over a shared one.
    const servers = await getPlexServers(token, link.clientIdentifier);
    const server = servers.find((s) => s.owned) ?? servers[0];
    if (!server) {
      throw new PlexUnreachableError();
    }
    db.update(plexLinks)
      .set({ machineIdentifier: server.clientIdentifier })
      .where(eq(plexLinks.id, link.id))
      .run();
    machineIdentifier = server.clientIdentifier;
  }

  const resolved = await resolveServerConnection({
    machineIdentifier,
    token,
    clientIdentifier: link.clientIdentifier,
    cache: { cachedConnectionUri: link.cachedConnectionUri, connectionCheckedAt: link.connectionCheckedAt },
    forceReprobe: opts.forceReprobe,
  });

  if (!resolved) {
    throw new PlexUnreachableError();
  }

  if (resolved.changed) {
    db.update(plexLinks)
      .set({ cachedConnectionUri: resolved.uri, connectionCheckedAt: new Date() })
      .where(eq(plexLinks.id, link.id))
      .run();
  }

  return {
    linkId: link.id,
    machineIdentifier,
    token,
    clientIdentifier: link.clientIdentifier,
    connectionUri: resolved.uri,
  };
}
