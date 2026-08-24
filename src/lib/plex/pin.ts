// ---------------------------------------------------------------------------
// Plex PIN auth flow.
//
// CONSTRAINT 1 (master plan): Plex shipped a new clients.plex.tv JWT auth
// flow in late 2025, but PMS itself still rejects those JWTs with a 401, and
// /api/v2/resources under the JWT flow returns JWT-form per-server tokens
// that don't work against PMS either. Unresolved as of 2026-07-19. EVERY bit
// of Plex token acquisition therefore stays on the legacy `plex.tv/api/v2`
// PIN flow, and it all lives in this one file, on purpose: if/when Plex
// fixes PMS-side JWT support, only this module needs to change — nothing
// downstream (resources.ts, library.ts, the proxy routes) should ever know
// or care how the token was obtained. Do NOT reach for clients.plex.tv here.
//
// CONSTRAINT 2: the app.plex.tv auth URL takes its params after a `#?`
// fragment, not as a normal `?` query string. Building it as a query string
// fails *silently* (the page loads, login appears to work, but the PIN is
// never actually associated with the client) — this is the single easiest
// way to lose an afternoon on this integration.
//
// CONSTRAINT 3: X-Plex-Client-Identifier must be a UUIDv4 generated once per
// user and persisted forever. This module never generates one itself beyond
// exposing generateClientIdentifier() (re-exported from headers.ts) — the
// caller (the pin/start route) decides whether to mint a fresh one or reuse
// an existing plex_links.client_identifier.
// ---------------------------------------------------------------------------

import { plexHeaders } from "./headers";
import { fetchPlexJson, PlexRequestError } from "./http";
import { coerceInt, coerceString } from "./util";

export { generateClientIdentifier } from "./headers";

const PLEX_TV_BASE = "https://plex.tv/api/v2";

// Constraint 10: plex.tv rate limits are real, undocumented, and a 429 often
// needs a Plex staff manual reset. Never poll faster than this.
export const MIN_PIN_POLL_INTERVAL_MS = 1000;

// Fallback only — the real flow always uses `expiresIn` from the PIN
// creation response (Plex's docs say ~15-30 minutes, but hardcoding a
// number instead of reading the field is exactly the kind of assumption
// that breaks quietly if Plex changes it).
const FALLBACK_EXPIRY_SECONDS = 30 * 60;

export interface PlexPin {
  id: number;
  code: string;
  /** Seconds until this PIN expires, as reported by Plex — never hardcoded. */
  expiresIn: number;
}

export interface PinPollResult {
  /** null while still unclaimed; the real Plex auth token once the user has
   *  completed login at app.plex.tv. */
  authToken: string | null;
}

/** POSTs a new PIN. `strong=true` requests a PIN that (per Plex's docs)
 *  can't be guessed by brute force in the time it's valid for. */
export async function createPin(clientIdentifier: string): Promise<PlexPin> {
  const body = await fetchPlexJson(`${PLEX_TV_BASE}/pins`, plexHeaders(clientIdentifier), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ strong: "true" }).toString(),
  });
  const data = body as { id?: unknown; code?: unknown; expiresIn?: unknown };
  const id = coerceInt(data.id);
  const code = coerceString(data.code);
  if (id === undefined || !code) {
    throw new Error("Plex PIN creation returned an unexpected shape");
  }
  return { id, code, expiresIn: coerceInt(data.expiresIn) ?? FALLBACK_EXPIRY_SECONDS };
}

/** Builds the app.plex.tv auth URL. CONSTRAINT 2: params go after `#?`, not
 *  in the normal query string — a client-side-only fragment that app.plex.tv
 *  reads with JS after the page loads. Putting these in the query string
 *  instead is accepted silently by the URL but the login page then has no
 *  idea which PIN to associate, so the poll below just spins until expiry. */
export function buildAuthUrl(params: {
  clientIdentifier: string;
  code: string;
  forwardUrl: string;
}): string {
  const fragmentParams = new URLSearchParams({
    clientID: params.clientIdentifier,
    code: params.code,
    forwardUrl: params.forwardUrl,
    "context[device][product]": "What to Watch",
  });
  return `https://app.plex.tv/auth#?${fragmentParams.toString()}`;
}

/** Polls a PIN exactly once. Callers are responsible for not calling this
 *  faster than MIN_PIN_POLL_INTERVAL_MS (constraint 10) — a route handler
 *  backing a browser-driven poll loop naturally satisfies this as long as
 *  the frontend's poll interval respects it; see
 *  src/app/api/auth/plex/poll (the Plex-only login flow's poll route). */
export async function pollPin(
  pinId: number,
  code: string,
  clientIdentifier: string,
): Promise<PinPollResult> {
  const url = new URL(`${PLEX_TV_BASE}/pins/${pinId}`);
  url.searchParams.set("code", code);
  url.searchParams.set("X-Plex-Client-Identifier", clientIdentifier);

  try {
    const body = await fetchPlexJson(url.toString(), plexHeaders(clientIdentifier));
    const data = body as { authToken?: unknown };
    const authToken = coerceString(data.authToken);
    return { authToken: authToken && authToken.length > 0 ? authToken : null };
  } catch (err) {
    if (err instanceof PlexRequestError && err.status === 404) {
      // PIN expired/unknown to Plex — treat like "never claimed" rather than
      // throwing, so callers can surface a clean "expired, try again".
      return { authToken: null };
    }
    throw err;
  }
}

/** Convenience loop for non-request contexts (tests, scripts) that waits for
 *  a PIN to be claimed, sleeping at least MIN_PIN_POLL_INTERVAL_MS between
 *  polls and bounding the whole wait by the PIN's own `expiresIn` — never a
 *  hardcoded 30 minutes. The actual /api/auth/plex/poll route does NOT use
 *  this; it does one pollPin() per browser-driven HTTP request instead, so
 *  the poll cadence is governed by the frontend's request interval and this
 *  server never independently hammers plex.tv on its own timer. */
export async function waitForPinAuth(
  pin: PlexPin,
  clientIdentifier: string,
  opts: { pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | null> {
  const pollIntervalMs = Math.max(opts.pollIntervalMs ?? MIN_PIN_POLL_INTERVAL_MS, MIN_PIN_POLL_INTERVAL_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + pin.expiresIn * 1000;

  while (Date.now() < deadline) {
    const { authToken } = await pollPin(pin.id, pin.code, clientIdentifier);
    if (authToken) return authToken;
    await sleep(pollIntervalMs);
  }
  return null;
}

export interface PlexAccountIdentity {
  /** Stable plex.tv account id — the find-or-create key for Plex-only login
   *  (see src/lib/plex/account.ts). Stored as text like every other id in
   *  this schema even though it arrives as a number on the wire. */
  id: string;
  username: string;
  email: string;
  thumb: string | null;
}

/** Resolves the Plex account identity behind a freshly-claimed token, via
 *  the same /api/v2/user endpoint validatePlexToken uses below — this is
 *  additive, not a rewrite of that function, since validatePlexToken only
 *  needs the status code and this needs the body. Used exclusively by the
 *  Plex-only login flow (src/app/api/auth/plex/poll) to turn a claimed PIN
 *  into an account identity to find-or-create a user from. */
export async function getPlexAccountIdentity(
  token: string,
  clientIdentifier: string,
): Promise<PlexAccountIdentity> {
  const body = await fetchPlexJson(
    `${PLEX_TV_BASE}/user`,
    plexHeaders(clientIdentifier, { "X-Plex-Token": token }),
  );
  const data = body as { id?: unknown; username?: unknown; email?: unknown; thumb?: unknown };
  const id = coerceString(data.id);
  const username = coerceString(data.username);
  const email = coerceString(data.email);
  if (!id || !username || !email) {
    throw new Error("Plex /api/v2/user returned an unexpected shape");
  }
  return { id, username, email, thumb: coerceString(data.thumb) ?? null };
}

/** Validates a token by calling /api/v2/user: 200 = valid, 401 = invalid.
 *  Any other status is a genuine error (network issue, plex.tv outage, a
 *  429) and is thrown rather than silently treated as "invalid", since that
 *  distinction matters for whether the caller should prompt a re-link. */
export async function validatePlexToken(token: string, clientIdentifier: string): Promise<boolean> {
  try {
    await fetchPlexJson(`${PLEX_TV_BASE}/user`, plexHeaders(clientIdentifier, { "X-Plex-Token": token }));
    return true;
  } catch (err) {
    if (err instanceof PlexRequestError && err.status === 401) {
      return false;
    }
    throw err;
  }
}
