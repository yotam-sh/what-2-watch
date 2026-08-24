// ---------------------------------------------------------------------------
// Shared X-Plex-* request headers. Every call this app makes to plex.tv or a
// PMS/Discover host needs the same identity headers — centralizing them
// means the client identifier can never accidentally diverge between, say,
// the PIN flow and a library sync request.
// ---------------------------------------------------------------------------

export const PLEX_PRODUCT = "What to Watch";
export const PLEX_DEVICE = "What to Watch (server)";
export const PLEX_PLATFORM = "Node.js";

// Bumped manually; Plex uses this only for display in the user's "Authorized
// Devices" list, it has no functional effect on the API.
export const PLEX_VERSION = "0.1.0";

/** Builds the common X-Plex-* header set. `clientIdentifier` must be the
 *  UUIDv4 persisted in `plex_links.client_identifier` (constraint 3) —
 *  never a freshly generated one, except during the one-time PIN flow for a
 *  user who has no link yet. */
export function plexHeaders(
  clientIdentifier: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Version": PLEX_VERSION,
    "X-Plex-Client-Identifier": clientIdentifier,
    "X-Plex-Device": PLEX_DEVICE,
    "X-Plex-Device-Name": PLEX_PRODUCT,
    "X-Plex-Platform": PLEX_PLATFORM,
    ...extra,
  };
}

/** Generates a fresh UUIDv4 client identifier. Call this exactly once per
 *  user, the first time they start a PIN flow with no existing plex_links
 *  row — see src/lib/plex/pin.ts for the full rationale (constraint 3). */
export function generateClientIdentifier(): string {
  return crypto.randomUUID();
}
