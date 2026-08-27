// ---------------------------------------------------------------------------
// Server discovery + connection selection.
//
// CONSTRAINT 10: plex.tv rate limits are real, undocumented, and a 429 often
// needs a Plex staff manual reset. /api/v2/resources is therefore cached
// in-process for hours and NEVER polled on a timer — every caller goes
// through getPlexServers() below, never fetchPlexServers() directly, unless
// it deliberately wants to force a refresh (e.g. "my server moved, relink").
//
// CONSTRAINT 12: candidates are ordered local -> remote -> relay, then
// https -> http, then IPv4 -> IPv6, and raced concurrently — but "raced" here
// means "fire all the /identity probes at once and take the *most preferred*
// one that succeeds", not "take whichever answers first". A relay hop can
// easily answer faster than a LAN device that's asleep and waking up on
// first request, and preferring speed over preference would flap the
// connection between relay and local on every sync. See selectBestConnection.
// ---------------------------------------------------------------------------

import { plexHeaders } from "./headers";
import { fetchPlexJson } from "./http";
import { coerceArray, coerceBool, coerceString } from "./util";

const PLEX_TV_BASE = "https://plex.tv/api/v2";
const IDENTITY_PROBE_TIMEOUT_MS = 5000;

// How long a cached /resources response is trusted before we're willing to
// hit plex.tv again. Deliberately hours, per constraint 10 — this is a
// correctness requirement (avoid the 429), not a performance knob.
export const RESOURCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// How long a cached *connection* winner is trusted before we re-probe it
// speculatively (as opposed to re-probing immediately on an actual failure,
// which callers do regardless of this TTL — see resolveServerConnection).
export const CONNECTION_CACHE_TTL_MS = 60 * 60 * 1000;

export interface PlexConnection {
  uri: string;
  protocol: "https" | "http";
  address: string;
  port: number;
  local: boolean;
  relay: boolean;
  ipv6: boolean;
}

export interface PlexResource {
  name: string;
  clientIdentifier: string; // == machine_identifier
  provides: string[];
  owned: boolean;
  accessToken?: string;
  connections: PlexConnection[];
}

interface RawConnection {
  uri?: string;
  protocol?: string;
  address?: string;
  port?: unknown;
  local?: unknown;
  relay?: unknown;
  IPv6?: unknown;
}

interface RawResource {
  name?: string;
  clientIdentifier?: string;
  provides?: string;
  owned?: unknown;
  accessToken?: string;
  connections?: RawConnection[];
}

function normalizeConnection(raw: RawConnection): PlexConnection | null {
  const uri = coerceString(raw.uri);
  const address = coerceString(raw.address);
  if (!uri || !address) return null;
  return {
    uri,
    protocol: raw.protocol === "http" ? "http" : "https",
    address,
    port: Number(raw.port) || 0,
    local: coerceBool(raw.local),
    relay: coerceBool(raw.relay),
    ipv6: coerceBool(raw.IPv6),
  };
}

function normalizeResource(raw: RawResource): PlexResource | null {
  const clientIdentifier = coerceString(raw.clientIdentifier);
  if (!clientIdentifier) return null;
  const provides = (raw.provides ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    name: coerceString(raw.name) ?? "",
    clientIdentifier,
    provides,
    owned: coerceBool(raw.owned),
    accessToken: raw.accessToken,
    connections: coerceArray(raw.connections)
      .map(normalizeConnection)
      .filter((c): c is PlexConnection => c !== null),
  };
}

/** Raw, uncached fetch of /api/v2/resources. Prefer getPlexServers() below —
 *  call this directly only when a caller has already decided a fresh fetch
 *  is warranted (it still counts against the plex.tv rate limit). */
export async function fetchPlexServers(token: string, clientIdentifier: string): Promise<PlexResource[]> {
  const url = `${PLEX_TV_BASE}/resources?includeHttps=1&includeRelay=1&includeIPv6=1`;
  const body = await fetchPlexJson(url, plexHeaders(clientIdentifier, { "X-Plex-Token": token }));
  const resources = coerceArray(body as RawResource[] | RawResource);
  return resources
    .map(normalizeResource)
    .filter((r): r is PlexResource => r !== null)
    .filter((r) => r.provides.includes("server"));
}

interface ResourceCacheEntry {
  resources: PlexResource[];
  fetchedAt: number;
}

// Keyed by client identifier — one entry per linked account. Same tradeoff
// as sessionStore.ts: lost on process restart, which just means the very
// next sync after a restart pays for one real /resources call.
const resourceCache = new Map<string, ResourceCacheEntry>();

/** Cached, rate-limit-safe entry point for server discovery. Always call
 *  this instead of fetchPlexServers() directly. */
export async function getPlexServers(
  token: string,
  clientIdentifier: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<PlexResource[]> {
  const cached = resourceCache.get(clientIdentifier);
  if (!opts.forceRefresh && cached && Date.now() - cached.fetchedAt < RESOURCE_CACHE_TTL_MS) {
    return cached.resources;
  }
  const resources = await fetchPlexServers(token, clientIdentifier);
  resourceCache.set(clientIdentifier, { resources, fetchedAt: Date.now() });
  return resources;
}

/** Test-only escape hatch — production code never needs to reset this. */
export function _clearResourceCache(): void {
  resourceCache.clear();
  deviceCache.clear();
}

// ---- account device registry ----------------------------------------------
//
// Every device this account has ever signed in on. Distinct from /resources
// above, which lists what the account can *access* (servers) — this is the
// registry of devices, including players and controllers.
//
// It exists here for ONE purpose: ownership. A PMS's /clients endpoint is
// server-scoped, so on a shared server every household member sees every
// announced client — including other people's phones and televisions.
// /clients carries no user field to filter on, so the only way to answer
// "is this device mine" is to intersect it with the asking account's own
// device registry.
//
// DO NOT filter this list by `provides`. It is tempting and it is wrong:
// the Android TV client that demonstrably accepts playback commands
// registers here as `provides=controller`, not `player`. Playback capability
// is decided by /clients' protocolCapabilities; this list decides ownership
// only.

interface DeviceCacheEntry {
  identifiers: Set<string>;
  fetchedAt: number;
}

const deviceCache = new Map<string, DeviceCacheEntry>();

/** Same 6-hour TTL and same reasoning as the resource cache: plex.tv rate
 *  limits are undocumented and a hard 429 can need a Plex staff manual
 *  reset (constraint 10). This is called on every "which devices can I play
 *  on" request, so it must not hit the network each time. */
export async function getAccountDeviceIdentifiers(
  token: string,
  clientIdentifier: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<Set<string>> {
  const cached = deviceCache.get(clientIdentifier);
  if (!opts.forceRefresh && cached && Date.now() - cached.fetchedAt < RESOURCE_CACHE_TTL_MS) {
    return cached.identifiers;
  }

  const body = await fetchPlexJson(
    `${PLEX_TV_BASE}/devices`,
    plexHeaders(clientIdentifier, { "X-Plex-Token": token }),
  );
  const identifiers = new Set<string>();
  for (const d of coerceArray(body as Array<Record<string, unknown>>)) {
    const id = coerceString(d?.clientIdentifier);
    if (id) identifiers.add(id);
  }
  deviceCache.set(clientIdentifier, { identifiers, fetchedAt: Date.now() });
  return identifiers;
}

// ---- connection ordering + selection (pure, unit-tested) ----

/** Lower = tried first. local(0) < remote(1) < relay(2); within a tier,
 *  https(0) < http(1); within that, IPv4(0) < IPv6(1). */
export function connectionSortKey(conn: PlexConnection): number {
  const tier = conn.relay ? 2 : conn.local ? 0 : 1;
  const protoRank = conn.protocol === "https" ? 0 : 1;
  const ipRank = conn.ipv6 ? 1 : 0;
  return tier * 100 + protoRank * 10 + ipRank;
}

/** Orders candidates local -> remote -> relay, https -> http, IPv4 -> IPv6
 *  (constraint 12). Pure — safe to unit test with fixture connections. */
export function orderConnections(connections: PlexConnection[]): PlexConnection[] {
  return [...connections].sort((a, b) => connectionSortKey(a) - connectionSortKey(b));
}

export type ConnectionProbe = (conn: PlexConnection, token: string) => Promise<boolean>;

/** GET {uri}/identity with a ~5s timeout. Also naturally handles the
 *  plex.direct local-URI failure case (routers with DNS-rebinding
 *  protection): that connection's fetch simply fails/times out like any
 *  other unreachable candidate, and selectBestConnection falls through to
 *  the next-preferred one — no special-casing needed. */
export const probeConnection: ConnectionProbe = async (conn, token) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IDENTITY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${conn.uri}/identity`, {
      headers: { "X-Plex-Token": token, Accept: "application/json" },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

/** Races /identity across every candidate concurrently, then returns the
 *  most-preferred (per orderConnections) one that actually succeeded — not
 *  necessarily the one that answered fastest. `probe` is injectable so this
 *  is unit-testable without any network I/O. */
export async function selectBestConnection(
  connections: PlexConnection[],
  token: string,
  probe: ConnectionProbe = probeConnection,
): Promise<PlexConnection | null> {
  const ordered = orderConnections(connections);
  if (ordered.length === 0) return null;

  const results = await Promise.all(
    ordered.map(async (conn) => ({ conn, ok: await probe(conn, token) })),
  );
  const winner = results.find((r) => r.ok);
  return winner ? winner.conn : null;
}

// ---- cache-aware resolution used by the sync/proxy routes ----

export interface CachedConnectionState {
  cachedConnectionUri: string | null;
  connectionCheckedAt: Date | null;
}

/** Pure freshness check — unit-testable without touching the clock. */
export function isConnectionCacheFresh(state: CachedConnectionState, now: number = Date.now()): boolean {
  if (!state.cachedConnectionUri || !state.connectionCheckedAt) return false;
  return now - state.connectionCheckedAt.getTime() < CONNECTION_CACHE_TTL_MS;
}

export interface ResolvedConnection {
  uri: string;
  /** True when the caller should persist this back to plex_links (a fresh
   *  race happened); false when the existing cache was reused untouched. */
  changed: boolean;
}

/** Resolves the PMS base URI to use for a given server. Reuses the cached
 *  URI when it's still fresh and `forceReprobe` isn't set (e.g. a sync route
 *  calls this normally); callers must set `forceReprobe: true` and re-call
 *  after an actual request against the cached URI fails, per constraint 12's
 *  "cache the winner ... re-probe on failure". */
export async function resolveServerConnection(params: {
  machineIdentifier: string;
  token: string;
  clientIdentifier: string;
  cache: CachedConnectionState;
  forceReprobe?: boolean;
}): Promise<ResolvedConnection | null> {
  const { machineIdentifier, token, clientIdentifier, cache, forceReprobe } = params;

  if (!forceReprobe && isConnectionCacheFresh(cache)) {
    return { uri: cache.cachedConnectionUri!, changed: false };
  }

  const servers = await getPlexServers(token, clientIdentifier, { forceRefresh: forceReprobe });
  const server = servers.find((s) => s.clientIdentifier === machineIdentifier);
  if (!server) return null;

  const winner = await selectBestConnection(server.connections, token);
  if (!winner) return null;

  return { uri: winner.uri, changed: true };
}
