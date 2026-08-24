"use client";

// ---------------------------------------------------------------------------
// Client-side helpers for the Plex server picker: GET /api/plex/servers +
// POST /api/plex/servers/selection. Mirrors plexSync.ts's convention of
// duplicating the response shape here rather than importing server-only
// modules (link.ts transitively pulls in @/db/client) into the client
// bundle.
// ---------------------------------------------------------------------------
import { getJson, postJson } from "./http";

export interface PlexServerOption {
  machineIdentifier: string;
  name: string;
  owned: boolean;
  selected: boolean;
  reachable: boolean;
}

export interface PlexServersResponse {
  servers: PlexServerOption[];
  /** True when the account has more than one server and none is selected
   *  yet — the picker must be shown and nothing can sync until the user
   *  chooses at least one. */
  needsSelection: boolean;
}

export function getPlexServerOptions() {
  return getJson<PlexServersResponse>("/api/plex/servers");
}

export function setPlexServerSelection(machineIdentifiers: string[]) {
  return postJson<{ ok: true }>("/api/plex/servers/selection", { machineIdentifiers });
}
