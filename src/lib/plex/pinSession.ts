// ---------------------------------------------------------------------------
// In-memory store for in-progress PIN flows — mirrors the pattern in
// src/lib/auth/sessionStore.ts.
//
// WHY THIS EXISTS: `plex_links.token_ciphertext` is NOT NULL (schema.ts), so
// a plex_links row can only be written once we actually have a token to
// encrypt into it. But constraint 3 says the client identifier is generated
// once and persisted in that same column — which we can't do yet at the
// moment we mint the PIN, before the user has finished logging in at
// app.plex.tv. This module bridges that gap: it holds the client identifier
// + pin id/code in memory between "start" and "poll", and the poll route
// only writes plex_links once, atomically, with both the (possibly reused)
// client identifier and the freshly-obtained encrypted token together.
//
// Consequence, same tradeoff sessionStore.ts already accepts: a process
// restart mid-flow loses the pending state, and the user just starts over
// (which mints a fresh identifier only for a flow that was never completed
// — no plex_links row, and therefore no persisted identifier, ever existed
// for it). Once a flow *does* complete, its identifier is persisted forever
// in plex_links, exactly as constraint 3 requires. See the Phase 2 report
// for why this wasn't solved with a schema change instead.
// ---------------------------------------------------------------------------

interface PendingPin {
  pinId: number;
  code: string;
  clientIdentifier: string;
  createdAt: number;
}

const pendingPins = new Map<string, PendingPin>(); // keyed by userId

export function setPendingPin(userId: string, pin: PendingPin): void {
  pendingPins.set(userId, pin);
}

export function getPendingPin(userId: string): PendingPin | undefined {
  return pendingPins.get(userId);
}

export function clearPendingPin(userId: string): void {
  pendingPins.delete(userId);
}
