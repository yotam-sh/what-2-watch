// ---------------------------------------------------------------------------
// Plex Companion playback control — "play this on the TV".
//
// Companion is undocumented and the observable behaviour is genuinely
// counter-intuitive, so the findings below were established against a real
// Plex for Android (TV) client and are the reason this module is shaped the
// way it is. Do not "simplify" any of them away without re-testing on real
// hardware.
//
//  1. THE RESPONSE BODY IS MEANINGLESS. Every command — a successful play, a
//     play with a nonexistent ratingKey, a malformed ratingKey, a stop —
//     returns byte-identical `HTTP 200 / text/plain / "Failure: 200 OK\r\n"`.
//     It carries no information whatsoever. Nothing here parses it, and no
//     caller may treat it as a result. There is NO fast-fail path.
//
//  2. THE SERVER'S SESSION LIST IS THE ONLY GROUND TRUTH. A successful play
//     shows up in /status/sessions after roughly 8 seconds cold, ~4 warm.
//     An earlier version of this checked after 4s, saw nothing, and reported
//     failure while the film was playing on the television.
//
//  3. A PLAY COMMAND SILENTLY TAKES OVER whatever the client is already
//     playing. Plex offers no guard, no prompt, no error — the old session
//     is simply replaced. In a household that means hijacking someone
//     else's film, so callers must check `busy` first and confirm.
//     The interrupted item DOES keep its resume position.
//
//  4. NEVER START WITHOUT BEING ABLE TO STOP. A start whose confirmation
//     poll times out is not necessarily a failure — it may be a slow
//     success, and leaving it produces an orphaned stream that burns a
//     transcode slot and, far worse, eventually writes a watch event for a
//     film nobody watched, poisoning the taste model this whole app is
//     built on. stopPlayback() exists for exactly that path.
//
//  5. Discovery requires "Advertise as player" enabled on the client AND an
//     app restart. The toggle alone does not re-announce. An empty player
//     list almost always means that, so the UI says so explicitly.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plexItems } from "@/db/schema";
import { getLinkedServerContexts, type LinkedServerContext } from "./link";
import { plexHeaders } from "./headers";
import { fetchPlexJson } from "./http";
import { coerceArray } from "./util";

/** Measured at ~8s cold / ~4s warm; 20s leaves headroom for a sleepy client
 *  without leaving the user staring at a spinner indefinitely. */
export const PLAYBACK_CONFIRM_TIMEOUT_MS = 20_000;

export interface PlexPlayer {
  machineIdentifier: string;
  name: string;
  product: string;
  /** machine_identifier of the server this player announced itself to. */
  serverMachineIdentifier: string;
  /** What this player is currently playing, if anything — the takeover
   *  warning depends on it. */
  busy: { title: string; ratingKey: string } | null;
}

interface RawClient {
  name?: string;
  product?: string;
  machineIdentifier?: string;
  address?: string;
  port?: string | number;
  protocolCapabilities?: string;
}

interface RawSession {
  title?: string;
  ratingKey?: string | number;
  viewOffset?: string | number;
  Player?: Array<{ machineIdentifier?: string; state?: string }> | { machineIdentifier?: string; state?: string };
}

function headersFor(ctx: LinkedServerContext): Record<string, string> {
  return plexHeaders(ctx.clientIdentifier, { "X-Plex-Token": ctx.token });
}

async function fetchSessions(ctx: LinkedServerContext): Promise<RawSession[]> {
  const body = await fetchPlexJson(`${ctx.connectionUri}/status/sessions`, headersFor(ctx));
  const container = (body as { MediaContainer?: { Metadata?: unknown } }).MediaContainer;
  return coerceArray(container?.Metadata as RawSession[] | RawSession);
}

/** Every playback-capable client currently announcing itself, across all of
 *  the user's selected servers, annotated with what it's already playing.
 *
 *  "Currently announcing" is the operative word: this is a live list, not a
 *  registry. A device that isn't running Plex right now simply isn't here,
 *  which is correct — you cannot cast to a device that's asleep. */
export async function listPlayers(userId: string): Promise<PlexPlayer[]> {
  const { contexts } = await getLinkedServerContexts({ id: userId });
  const players: PlexPlayer[] = [];

  for (const ctx of contexts) {
    let clients: RawClient[] = [];
    let sessions: RawSession[] = [];
    try {
      const body = await fetchPlexJson(`${ctx.connectionUri}/clients`, headersFor(ctx));
      const container = (body as { MediaContainer?: { Server?: unknown } }).MediaContainer;
      clients = coerceArray(container?.Server as RawClient[] | RawClient);
      sessions = await fetchSessions(ctx);
    } catch {
      // One unreachable server must not hide the players on another.
      continue;
    }

    for (const c of clients) {
      if (!c.machineIdentifier) continue;
      if (!(c.protocolCapabilities ?? "").split(",").includes("playback")) continue;

      const session = sessions.find((s) =>
        coerceArray(s.Player).some((p) => p?.machineIdentifier === c.machineIdentifier),
      );

      players.push({
        machineIdentifier: c.machineIdentifier,
        name: c.name ?? "Unnamed device",
        product: c.product ?? "",
        serverMachineIdentifier: ctx.machineIdentifier,
        busy: session ? { title: String(session.title ?? "Something"), ratingKey: String(session.ratingKey ?? "") } : null,
      });
    }
  }

  return players;
}

/** Where a title actually lives: which server, under which rating key, and
 *  how far in the user already is. Returns null when this user has no Plex
 *  row for the title — a Letterboxd-only watch, for instance, which can be
 *  recommended but not played. */
function resolvePlayableItem(
  userId: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
): { ratingKey: string; serverMachineIdentifier: string; viewOffsetMs: number } | null {
  const row = db
    .select()
    .from(plexItems)
    .where(and(eq(plexItems.userId, userId), eq(plexItems.tmdbId, tmdbId), eq(plexItems.mediaType, mediaType)))
    .get();
  if (!row) return null;
  return {
    ratingKey: row.ratingKey,
    serverMachineIdentifier: row.machineIdentifier,
    // Resume where they left off. Verified exact against a real client:
    // sending 4648467ms resumed at 4648671ms, a ~200ms playback drift.
    viewOffsetMs: row.viewOffset ?? 0,
  };
}

export class PlaybackError extends Error {}

/** Fires the play command. Returns as soon as it's sent — confirmation is a
 *  separate, slow step (finding 2), so callers start this then poll
 *  isPlaying(). Deliberately does not wait: holding an HTTP request open for
 *  8+ seconds is what the background-job rewrite existed to stop. */
export async function startPlayback(params: {
  userId: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  playerMachineIdentifier: string;
}): Promise<{ ratingKey: string }> {
  const item = resolvePlayableItem(params.userId, params.tmdbId, params.mediaType);
  if (!item) throw new PlaybackError("That title isn't on your Plex server.");

  const { contexts } = await getLinkedServerContexts({ id: params.userId });
  const ctx = contexts.find((c) => c.machineIdentifier === item.serverMachineIdentifier);
  if (!ctx) throw new PlaybackError("The server holding this title isn't reachable right now.");

  const client = await findClient(ctx, params.playerMachineIdentifier);
  if (!client) throw new PlaybackError("That device is no longer available. Open Plex on it and try again.");

  const pms = new URL(ctx.connectionUri);
  const query = new URLSearchParams({
    key: `/library/metadata/${item.ratingKey}`,
    offset: String(item.viewOffsetMs),
    machineIdentifier: ctx.machineIdentifier,
    // The plex.direct hostname, never the bare IP: the certificate is issued
    // for that name, so an https connection to the raw address fails
    // verification on the client.
    address: pms.hostname,
    port: pms.port,
    protocol: pms.protocol.replace(":", ""),
    commandID: "1",
  });

  // No play queue, no token param, no X-Plex-Provides, no timeline
  // subscribe — all tested, none required for a single item.
  await sendCommand(ctx, client, `/player/playback/playMedia?${query}`);
  return { ratingKey: item.ratingKey };
}

/** Stops whatever the given client is playing. Confirmed to clear the
 *  session in under 2 seconds. */
export async function stopPlayback(userId: string, playerMachineIdentifier: string): Promise<void> {
  const { contexts } = await getLinkedServerContexts({ id: userId });
  for (const ctx of contexts) {
    const client = await findClient(ctx, playerMachineIdentifier);
    if (!client) continue;
    await sendCommand(ctx, client, `/player/playback/stop?${new URLSearchParams({ commandID: "9" })}`);
    return;
  }
  throw new PlaybackError("That device is no longer available.");
}

/** The only honest answer to "did it work". */
export async function isPlaying(userId: string, ratingKey: string): Promise<boolean> {
  const { contexts } = await getLinkedServerContexts({ id: userId });
  for (const ctx of contexts) {
    try {
      const sessions = await fetchSessions(ctx);
      if (sessions.some((s) => String(s.ratingKey) === ratingKey)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function findClient(ctx: LinkedServerContext, machineIdentifier: string): Promise<RawClient | null> {
  try {
    const body = await fetchPlexJson(`${ctx.connectionUri}/clients`, headersFor(ctx));
    const container = (body as { MediaContainer?: { Server?: unknown } }).MediaContainer;
    return (
      coerceArray(container?.Server as RawClient[] | RawClient).find(
        (c) => c.machineIdentifier === machineIdentifier,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Commands go straight to the client over the LAN. The reply is read and
 *  discarded on purpose — see finding 1; parsing it would only ever produce
 *  a false negative. */
async function sendCommand(ctx: LinkedServerContext, client: RawClient, path: string): Promise<void> {
  const url = `http://${client.address}:${client.port}${path}`;
  try {
    const res = await fetch(url, {
      headers: { ...headersFor(ctx), "X-Plex-Target-Client-Identifier": client.machineIdentifier ?? "" },
    });
    await res.text();
  } catch (err) {
    // A transport-level failure is real (wrong IP, device gone). An
    // application-level "Failure" body is not, and never reaches here.
    throw new PlaybackError(
      `Couldn't reach ${client.name ?? "the device"} on your network: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}
