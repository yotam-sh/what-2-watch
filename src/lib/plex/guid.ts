// ---------------------------------------------------------------------------
// External-id (TMDB/IMDB/TVDB) extraction from a Plex item.
//
// Constraint 7: modern agents expose external ids as `Guid` child elements
// (`tmdb://603`, `imdb://tt0133093`, `tvdb://121361`); legacy
// `com.plexapp.agents.*` items instead carry a single id directly in the
// top-level `guid` attribute (e.g. `com.plexapp.agents.themoviedb://603?lang=en`
// or `com.plexapp.agents.imdb://tt0133093?lang=en`). Both coexist in the same
// library, so every item must be probed for both shapes rather than assuming
// one agent generation. A modern-agent item's own top-level `guid` is an
// *opaque* `plex://movie/<hash>` identifier, not an external id — the regexes
// below simply don't match that shape, so it safely contributes nothing.
// ---------------------------------------------------------------------------

import { coerceArray } from "./util";

export interface ExternalIds {
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: string | null;
}

export interface RawGuid {
  id?: string;
}

export interface GuidBearingItem {
  guid?: string;
  Guid?: RawGuid[] | RawGuid;
}

const NO_IDS: ExternalIds = { tmdbId: null, imdbId: null, tvdbId: null };

// Modern agent guid, e.g. "tmdb://603", "imdb://tt0133093", "tvdb://121361".
const MODERN_GUID_RE = /^(tmdb|imdb|tvdb):\/\/([^?/]+)/i;

// Legacy agent guid, e.g. "com.plexapp.agents.themoviedb://603?lang=en",
// "com.plexapp.agents.imdb://tt0133093?lang=en",
// "com.plexapp.agents.thetvdb://121361?lang=en".
const LEGACY_GUID_RE = /^com\.plexapp\.agents\.([a-z0-9]+):\/\/([^?/]+)/i;

function applyMatch(
  target: { tmdbId: number | null; imdbId: string | null; tvdbId: string | null },
  provider: string,
  id: string,
): void {
  const p = provider.toLowerCase();
  if ((p === "tmdb" || p === "themoviedb") && target.tmdbId === null) {
    const n = Number(id);
    if (Number.isFinite(n)) target.tmdbId = n;
  } else if (p === "imdb" && target.imdbId === null) {
    target.imdbId = id;
  } else if ((p === "tvdb" || p === "thetvdb") && target.tvdbId === null) {
    target.tvdbId = id;
  }
}

/** Parses a single guid string (from either a `Guid` child's `id` or the
 *  top-level `guid` attribute) and merges anything it finds into `target`. */
function parseGuidInto(
  guid: string,
  target: { tmdbId: number | null; imdbId: string | null; tvdbId: string | null },
): void {
  const modern = MODERN_GUID_RE.exec(guid);
  if (modern) {
    applyMatch(target, modern[1], modern[2]);
    return;
  }
  const legacy = LEGACY_GUID_RE.exec(guid);
  if (legacy) {
    applyMatch(target, legacy[1], legacy[2]);
  }
}

/** Extracts whatever external ids can be found on a Plex item, checking both
 *  the modern `Guid` children and the legacy top-level `guid` string. Missing
 *  or unrecognized ids come back `null`, never throw — the "no id" case is a
 *  first-class, expected outcome (unmatched libraries, oddball agents). */
export function extractExternalIds(item: GuidBearingItem | null | undefined): ExternalIds {
  if (!item) return { ...NO_IDS };

  const target = { tmdbId: null as number | null, imdbId: null as string | null, tvdbId: null as string | null };

  for (const g of coerceArray(item.Guid)) {
    if (g?.id) parseGuidInto(g.id, target);
  }
  if (item.guid) {
    parseGuidInto(item.guid, target);
  }

  return target;
}

/** True when an item looks like a modern-agent item (opaque `plex://` top
 *  level guid) that still has no resolved external ids — the signal that
 *  `includeGuids=1` either wasn't requested or didn't return `Guid` children,
 *  and the comma-joined `/library/metadata/{k1},{k2}` fallback is needed. */
export function needsGuidResolution(item: GuidBearingItem | null | undefined): boolean {
  if (!item) return false;
  const ids = extractExternalIds(item);
  const hasAnyId = ids.tmdbId !== null || ids.imdbId !== null || ids.tvdbId !== null;
  if (hasAnyId) return false;
  return typeof item.guid === "string" && item.guid.startsWith("plex://");
}
