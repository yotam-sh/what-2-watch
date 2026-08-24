// ---------------------------------------------------------------------------
// Loads a user's plex_links row, decrypts the token, resolves which of the
// account's Plex servers are selected (src/db/schema.ts's
// plex_selected_servers — see that table's doc comment for why selection is
// its own table), and resolves a live PMS connection URI for each. The
// shared setup every route that actually talks to a user's PMS (sync, image
// proxy) needs. Centralizing it means the re-probe-on-failure behavior
// (constraint 12, unchanged — see resources.ts) and the key_scope handling
// only have to be right once.
//
// SERVER PICKER: this used to silently do
// `servers.find((s) => s.owned) ?? servers[0]` the first time a link needed
// a server — meaning a user who owned nothing got a stranger's shared
// library scanned with no one ever choosing that. That fallback is gone.
// The rule now is:
//   - 0 selected, discovery finds 0 servers  -> PlexUnreachableError (same
//     as before: nothing to connect to).
//   - 0 selected, discovery finds exactly 1  -> auto-selected right here,
//     persisted, no picker ever shown (product requirement: "don't make
//     someone choose from a list of one").
//   - 0 selected, discovery finds 2+         -> PlexServerSelectionRequiredError.
//     Callers (sync job, image proxy) must surface "pick a server in
//     Settings" rather than guessing on the user's behalf.
//   - 1+ selected                            -> use exactly those, per
//     getLinkedServerContexts below.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plexLinks, plexSelectedServers } from "@/db/schema";
import { getPlexServers, resolveServerConnection, type PlexResource } from "./resources";
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

/** Thrown when the account has more than one Plex server and the user has
 *  never explicitly selected any of them. Distinct from PlexUnreachableError
 *  (which means "nothing worked") — this means "we won't guess which one you
 *  meant." Callers should surface this as "choose a server in Settings",
 *  not as a connection failure. */
export class PlexServerSelectionRequiredError extends Error {
  constructor() {
    super("More than one Plex server is available for this account — choose one in Settings.");
    this.name = "PlexServerSelectionRequiredError";
  }
}

/** Thrown by setSelectedServers when the requested selection is empty or
 *  names a machine_identifier that isn't actually a `provides=server`
 *  resource on this account (i.e. not something fetchPlexServers returned) —
 *  a client can only ever select from servers its own account can see. */
export class InvalidServerSelectionError extends Error {}

export interface LinkedServerContext {
  linkId: string;
  machineIdentifier: string;
  token: string;
  clientIdentifier: string;
  connectionUri: string;
}

export interface LinkedServerContexts {
  token: string;
  clientIdentifier: string;
  /** One entry per selected server whose connection resolved successfully,
   *  in plex_selected_servers row order. */
  contexts: LinkedServerContext[];
  /** machine_identifiers of servers that are selected but could NOT be
   *  reached this attempt (still selected — just unreachable right now).
   *  Callers report these as a partial-sync note rather than silently
   *  dropping them or failing the whole job over one flaky server. */
  unreachable: string[];
}

interface LoadedLink {
  id: string;
  userId: string;
  clientIdentifier: string;
  token: string;
}

function loadLinkAndToken(userId: string): LoadedLink {
  const link = db.select().from(plexLinks).where(eq(plexLinks.userId, userId)).get();
  if (!link) {
    throw new PlexNotLinkedError();
  }
  // No vaultKey to pass any more (see token.ts's file header) — every
  // current-model row is key_scope='server', which ignores this argument;
  // a legacy 'user'-scope row correctly throws VaultKeyUnavailableError.
  const token = decryptPlexToken({
    keyScope: link.keyScope,
    tokenCiphertext: link.tokenCiphertext,
    vaultKey: undefined,
  });
  return { id: link.id, userId, clientIdentifier: link.clientIdentifier, token };
}

/** Returns the caller's explicit selection, discovering + auto-selecting a
 *  lone server the first time there's nothing selected yet (see file
 *  header). Never returns an empty array — throws instead. */
async function ensureSelectedServers(
  link: LoadedLink,
): Promise<(typeof plexSelectedServers.$inferSelect)[]> {
  const existing = db
    .select()
    .from(plexSelectedServers)
    .where(eq(plexSelectedServers.userId, link.userId))
    .all();
  if (existing.length > 0) return existing;

  const servers = await getPlexServers(link.token, link.clientIdentifier);
  if (servers.length === 0) {
    throw new PlexUnreachableError();
  }
  if (servers.length > 1) {
    throw new PlexServerSelectionRequiredError();
  }

  const only = servers[0];
  db.insert(plexSelectedServers)
    .values({ userId: link.userId, machineIdentifier: only.clientIdentifier })
    // Defensive against a race between two concurrent first-syncs for the
    // same user — whichever wins, the re-select below reads the real row.
    .onConflictDoNothing({
      target: [plexSelectedServers.userId, plexSelectedServers.machineIdentifier],
    })
    .run();

  return db
    .select()
    .from(plexSelectedServers)
    .where(eq(plexSelectedServers.userId, link.userId))
    .all();
}

/** Loads the caller's plex_links row, decrypts the token per key_scope, and
 *  resolves a working PMS connection URI for every currently selected
 *  server (auto-selecting a lone server first, per the file header). Each
 *  selected server's connection is resolved independently — reusing that
 *  server's own cached URI if fresh, re-racing (and persisting the new
 *  winner) otherwise, exactly as resources.ts's constraint 12 always has.
 *  Pass `forceReprobe: true` after an actual PMS call using a cached URI has
 *  failed. Throws PlexUnreachableError only if EVERY selected server failed
 *  to resolve — a mix of reachable/unreachable selected servers instead
 *  returns the reachable ones in `contexts` and the rest in `unreachable`,
 *  so one flaky server doesn't take down a sync of the others. */
export async function getLinkedServerContexts(
  user: { id: string },
  opts: { forceReprobe?: boolean } = {},
): Promise<LinkedServerContexts> {
  const link = loadLinkAndToken(user.id);
  const selected = await ensureSelectedServers(link);

  // Independent per-server probes — resolveServerConnection's own race
  // (constraint 12) is unchanged; this just runs one such race per selected
  // server concurrently rather than making the caller wait on them one at a
  // time.
  const resolutions = await Promise.all(
    selected.map(async (sel) => ({
      sel,
      resolved: await resolveServerConnection({
        machineIdentifier: sel.machineIdentifier,
        token: link.token,
        clientIdentifier: link.clientIdentifier,
        cache: { cachedConnectionUri: sel.cachedConnectionUri, connectionCheckedAt: sel.connectionCheckedAt },
        forceReprobe: opts.forceReprobe,
      }),
    })),
  );

  const contexts: LinkedServerContext[] = [];
  const unreachable: string[] = [];

  for (const { sel, resolved } of resolutions) {
    if (!resolved) {
      unreachable.push(sel.machineIdentifier);
      continue;
    }
    if (resolved.changed) {
      db.update(plexSelectedServers)
        .set({ cachedConnectionUri: resolved.uri, connectionCheckedAt: new Date() })
        .where(eq(plexSelectedServers.id, sel.id))
        .run();
    }
    contexts.push({
      linkId: link.id,
      machineIdentifier: sel.machineIdentifier,
      token: link.token,
      clientIdentifier: link.clientIdentifier,
      connectionUri: resolved.uri,
    });
  }

  if (contexts.length === 0) {
    throw new PlexUnreachableError();
  }

  return { token: link.token, clientIdentifier: link.clientIdentifier, contexts, unreachable };
}

/** Single-connection convenience wrapper over getLinkedServerContexts, for
 *  callers that only ever need ANY one working connection — today that's
 *  just the image proxy (src/app/api/plex/image/route.ts), which addresses
 *  artwork by a bare Plex-relative path with no server of its own to pick
 *  from. KNOWN LIMITATION: if that path happens to belong to a *different*
 *  selected server than the one returned here, the fetch 404s — this route
 *  was already effectively single-server before this feature (posters are
 *  actually served from TMDB in this app; see PosterImage.tsx), so this is a
 *  pre-existing limitation being carried forward honestly, not a new one
 *  introduced here. Multi-server sync (syncJob.ts) does NOT use this
 *  function — it uses getLinkedServerContexts directly so every selected
 *  server actually gets synced. */
export async function getLinkedServerContext(
  user: { id: string },
  opts: { forceReprobe?: boolean } = {},
): Promise<LinkedServerContext> {
  const { contexts } = await getLinkedServerContexts(user, opts);
  return contexts[0];
}

// ---- server-picker support (SettingsScreen / GET+POST /api/plex/servers) ----

/** Read-only listing for the picker UI: every server discovery turns up for
 *  this account (owned and shared alike) plus which ones are currently
 *  selected. Deliberately does NOT auto-select a lone server as a side
 *  effect of a GET — that write only happens lazily, inside
 *  ensureSelectedServers, the first time a real connection is actually
 *  needed (a sync or an image fetch). The UI doesn't need the DB row to
 *  exist to render "no picker for a single server" — it can just check
 *  `servers.length <= 1` itself (see SettingsScreen.tsx). */
export async function listServersForPicker(userId: string): Promise<{
  servers: PlexResource[];
  selectedMachineIdentifiers: Set<string>;
  /** The decrypted account token — returned so the route can probe each
   *  server's reachability itself (resources.ts's selectBestConnection)
   *  without this module needing to know anything about "how the picker UI
   *  wants reachability computed." Server-side only: the route must never
   *  put this in the JSON response. */
  token: string;
}> {
  const link = loadLinkAndToken(userId);
  const servers = await getPlexServers(link.token, link.clientIdentifier);
  const selected = db
    .select()
    .from(plexSelectedServers)
    .where(eq(plexSelectedServers.userId, userId))
    .all();
  return {
    servers,
    selectedMachineIdentifiers: new Set(selected.map((s) => s.machineIdentifier)),
    token: link.token,
  };
}

/** Replaces the caller's selection with exactly `machineIdentifiers` —
 *  deselecting anything not in the set, selecting anything newly in it.
 *  Every id is validated against a fresh discovery call first: a client can
 *  only select machine_identifiers that are actually `provides=server`
 *  resources on their own Plex account (InvalidServerSelectionError
 *  otherwise), never an arbitrary string. An empty selection is rejected the
 *  same way — the app has no "select nothing" state.
 *
 *  Rows for servers that remain selected keep their existing connection
 *  cache untouched (no unnecessary re-probe); newly selected rows start with
 *  no cache and resolve on the next sync/context request, same as a
 *  brand-new auto-selection would.
 *
 *  DESELECTING DOES NOT TOUCH plex_items: a deselected server's synced watch
 *  history is retained, not purged — see plex_selected_servers' doc comment
 *  in schema.ts for why (mirrors what unlinking Plex entirely already does).
 *  Re-selecting the same server later just resumes writing into those same
 *  rows via plex_items' existing unique index. */
export async function setSelectedServers(userId: string, machineIdentifiers: string[]): Promise<void> {
  const desired = Array.from(new Set(machineIdentifiers));
  if (desired.length === 0) {
    throw new InvalidServerSelectionError("At least one server must stay selected.");
  }

  const link = loadLinkAndToken(userId);
  const servers = await getPlexServers(link.token, link.clientIdentifier);
  const validIds = new Set(servers.map((s) => s.clientIdentifier));
  const invalid = desired.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new InvalidServerSelectionError(
      `Not a Plex server on this account: ${invalid.join(", ")}`,
    );
  }

  const existing = db
    .select()
    .from(plexSelectedServers)
    .where(eq(plexSelectedServers.userId, userId))
    .all();
  const existingIds = new Set(existing.map((r) => r.machineIdentifier));
  const desiredIds = new Set(desired);

  for (const row of existing) {
    if (!desiredIds.has(row.machineIdentifier)) {
      db.delete(plexSelectedServers).where(eq(plexSelectedServers.id, row.id)).run();
    }
  }
  for (const machineIdentifier of desired) {
    if (!existingIds.has(machineIdentifier)) {
      db.insert(plexSelectedServers).values({ userId, machineIdentifier }).run();
    }
  }
}
