// ---------------------------------------------------------------------------
// Watched-state sync via library scans.
//
// CONSTRAINT 5: prefer library scans over /status/sessions/history/all,
// which gives only `viewedAt` + identity — no duration, no completion state.
// `/library/sections/{id}/all?type=1&viewCount>=1&sort=lastViewedAt:desc`
// returns current state (viewCount, lastViewedAt, viewOffset) in one
// paginated call. The `>=` in that filter must be URL-encoded as `%3E%3D` —
// building it with URLSearchParams instead would double-encode or mangle it,
// so the movie/episode scan paths below are built as literal strings.
//
// CONSTRAINT 6: show/season carry `leafCount`/`viewedLeafCount`; fully
// watched <=> those are equal. Show-level `viewCount` is NOT a rewatch count
// — rewatches must be read by aggregating episode-level `viewCount` (type=4)
// instead, rolled up via `grandparentRatingKey` (show) / `parentRatingKey`
// (season). See rollupEpisodesToShows / isShowFullyWatched.
//
// CONSTRAINT 9: X-Plex-Container-Size is capped at ~1000; some builds reject
// larger values with an explicit limit error.
//
// CONSTRAINT 7 / includeGuids probing: see resolveMovieExternalIds /
// resolveEpisodeExternalIds and the Phase 2 report for which path this
// project ended up needing — it could not be verified live during
// development (see file header note below the pagination helpers).
// ---------------------------------------------------------------------------

// NOTE: this file deliberately has NO import of "@/db/client" or any Drizzle
// schema table. Every function here is pure or does network I/O only, so
// unit tests can import it (for the pure functions) without ever opening the
// real on-disk SQLite database. The DB-writing orchestration that consumes
// these functions lives in librarySync.ts.

import { plexHeaders } from "./headers";
import { extractExternalIds, needsGuidResolution, type ExternalIds, type GuidBearingItem } from "./guid";
import { fetchPlexJson } from "./http";
import { coerceArray, coerceInt, coerceString } from "./util";

// Constraint 9.
export const MAX_CONTAINER_SIZE = 1000;

// Plex has no documented hard limit on comma-joined rating keys in
// /library/metadata/{k1},{k2},...}, but very long URLs risk hitting a proxy
// or PMS request-line limit — keep batches conservative.
const GUID_BATCH_SIZE = 50;

export interface PlexSection {
  key: string;
  title: string;
  type: string; // "movie" | "show"
}

interface RawSection {
  key?: unknown;
  title?: unknown;
  type?: unknown;
}

/** GET /library/sections — the list of libraries on the server. */
export async function fetchLibrarySections(
  connectionUri: string,
  token: string,
  clientIdentifier: string,
): Promise<PlexSection[]> {
  const body = await fetchPlexJson(
    `${connectionUri}/library/sections`,
    plexHeaders(clientIdentifier, { "X-Plex-Token": token }),
  );
  const container = (body as { MediaContainer?: { Directory?: RawSection[] | RawSection } }).MediaContainer;
  return coerceArray(container?.Directory)
    .map((d) => ({
      key: coerceString(d.key) ?? "",
      title: coerceString(d.title) ?? "",
      type: coerceString(d.type) ?? "",
    }))
    .filter((s) => s.key !== "");
}

// ---- raw item shape from a library scan ----

export interface RawPlexVideo extends GuidBearingItem {
  ratingKey?: unknown;
  title?: unknown;
  type?: unknown;
  year?: unknown;
  viewCount?: unknown;
  lastViewedAt?: unknown;
  viewOffset?: unknown;
  leafCount?: unknown;
  viewedLeafCount?: unknown;
  grandparentRatingKey?: unknown;
  parentRatingKey?: unknown;
}

export interface NormalizedPlexItem {
  ratingKey: string;
  title: string;
  year?: number;
  viewCount: number;
  lastViewedAt?: number; // epoch seconds
  viewOffset?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  grandparentRatingKey?: string;
  parentRatingKey?: string;
  externalIds: ExternalIds;
}

/** Normalizes one raw scan item defensively (constraint 8: numeric
 *  attributes sometimes arrive as strings). Pure — unit-testable. */
export function normalizePlexVideo(raw: RawPlexVideo): NormalizedPlexItem | null {
  const ratingKey = coerceString(raw.ratingKey);
  if (!ratingKey) return null;
  return {
    ratingKey,
    title: coerceString(raw.title) ?? "",
    year: coerceInt(raw.year),
    viewCount: coerceInt(raw.viewCount) ?? 0,
    lastViewedAt: coerceInt(raw.lastViewedAt),
    viewOffset: coerceInt(raw.viewOffset),
    leafCount: coerceInt(raw.leafCount),
    viewedLeafCount: coerceInt(raw.viewedLeafCount),
    grandparentRatingKey: coerceString(raw.grandparentRatingKey),
    parentRatingKey: coerceString(raw.parentRatingKey),
    externalIds: extractExternalIds(raw),
  };
}

/** An item is "in progress" (constraint: viewOffset present with
 *  viewCount == 0) rather than "watched". Pure — unit-testable. */
export function isInProgress(item: Pick<NormalizedPlexItem, "viewCount" | "viewOffset">): boolean {
  return item.viewCount === 0 && item.viewOffset !== undefined && item.viewOffset > 0;
}

/** Fully watched <=> leafCount === viewedLeafCount (constraint 6). Both must
 *  be present — an item with neither (e.g. a movie) is neither true nor
 *  false in any meaningful sense, so this returns false rather than
 *  guessing. Pure — unit-testable. */
export function isShowFullyWatched(show: { leafCount?: number; viewedLeafCount?: number }): boolean {
  return show.leafCount !== undefined && show.viewedLeafCount !== undefined && show.leafCount === show.viewedLeafCount;
}

// ---- episode -> show rollup (constraint 6, pure, unit-tested) ----

export interface ShowRollup {
  grandparentRatingKey: string;
  /** Sum of *episode* viewCounts — never the show's own viewCount field
   *  (constraint 6: that's not a rewatch count). */
  totalEpisodeViewCount: number;
  watchedEpisodeCount: number;
  /** Max lastViewedAt across all episodes, i.e. "last time anything in this
   *  show was watched". */
  lastViewedAt?: number;
  /** rating keys of episodes that are in-progress (viewOffset set, viewCount 0) */
  inProgressEpisodeRatingKeys: string[];
}

export function rollupEpisodesToShows(episodes: NormalizedPlexItem[]): Map<string, ShowRollup> {
  const rollups = new Map<string, ShowRollup>();
  for (const ep of episodes) {
    if (!ep.grandparentRatingKey) continue;
    const key = ep.grandparentRatingKey;
    const existing: ShowRollup = rollups.get(key) ?? {
      grandparentRatingKey: key,
      totalEpisodeViewCount: 0,
      watchedEpisodeCount: 0,
      lastViewedAt: undefined,
      inProgressEpisodeRatingKeys: [],
    };
    existing.totalEpisodeViewCount += ep.viewCount;
    if (ep.viewCount > 0) existing.watchedEpisodeCount += 1;
    if (ep.lastViewedAt !== undefined && (existing.lastViewedAt === undefined || ep.lastViewedAt > existing.lastViewedAt)) {
      existing.lastViewedAt = ep.lastViewedAt;
    }
    if (isInProgress(ep)) {
      existing.inProgressEpisodeRatingKeys.push(ep.ratingKey);
    }
    rollups.set(key, existing);
  }
  return rollups;
}

// ---- pagination (constraint 9: capped container size) ----

export interface PlexPage<T> {
  items: T[];
  totalSize: number;
}

/** Generic pager: repeatedly calls `fetchPage(start, size)` until it has
 *  consumed `totalSize` items or a page comes back empty. `size` is always
 *  clamped to MAX_CONTAINER_SIZE regardless of what's requested. */
export async function* paginate<T>(
  fetchPage: (start: number, size: number) => Promise<PlexPage<T>>,
  pageSize: number = MAX_CONTAINER_SIZE,
): AsyncGenerator<T[]> {
  const size = Math.min(pageSize, MAX_CONTAINER_SIZE);
  let start = 0;
  let total = Infinity;
  while (start < total) {
    const page = await fetchPage(start, size);
    total = page.totalSize;
    if (page.items.length === 0) break;
    yield page.items;
    start += page.items.length;
  }
}

// ---- scan path builders ----
// The `>=` filter operator must be URL-encoded as %3E%3D (constraint 5) —
// built as literal strings rather than URLSearchParams, which would encode
// `>` and `=` inconsistently depending on whether they land in a key or a
// value.

export function buildWatchedMoviesPath(sectionKey: string, start: number, size: number, includeGuids: boolean): string {
  const guidParam = includeGuids ? "&includeGuids=1" : "";
  return `/library/sections/${encodeURIComponent(sectionKey)}/all?type=1&viewCount%3E%3D1&sort=lastViewedAt:desc${guidParam}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
}

export function buildWatchedEpisodesPath(sectionKey: string, start: number, size: number, includeGuids: boolean): string {
  const guidParam = includeGuids ? "&includeGuids=1" : "";
  return `/library/sections/${encodeURIComponent(sectionKey)}/all?type=4&viewCount%3E%3D1${guidParam}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
}

export function buildAllShowsPath(sectionKey: string, start: number, size: number): string {
  return `/library/sections/${encodeURIComponent(sectionKey)}/all?type=2&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
}

export interface FetchCtx {
  connectionUri: string;
  token: string;
  clientIdentifier: string;
}

async function fetchOnePage(ctx: FetchCtx, path: string): Promise<{ items: RawPlexVideo[]; totalSize: number }> {
  const body = await fetchPlexJson(`${ctx.connectionUri}${path}`, plexHeaders(ctx.clientIdentifier, { "X-Plex-Token": ctx.token }));
  const container = (body as {
    MediaContainer?: { Video?: RawPlexVideo[] | RawPlexVideo; Directory?: RawPlexVideo[] | RawPlexVideo; totalSize?: unknown; size?: unknown };
  }).MediaContainer;
  const items = coerceArray(container?.Video ?? container?.Directory);
  const totalSize = coerceInt(container?.totalSize) ?? coerceInt(container?.size) ?? items.length;
  return { items, totalSize };
}

/** Batches comma-joined rating keys against /library/metadata/{k1},{k2},...
 *  — the fallback path from constraint 7 when includeGuids=1 doesn't (or
 *  can't be confirmed to) populate `Guid` children directly on the scan. */
export async function resolveGuidsViaBatch(
  ratingKeys: string[],
  ctx: FetchCtx,
): Promise<Map<string, ExternalIds>> {
  const result = new Map<string, ExternalIds>();
  for (let i = 0; i < ratingKeys.length; i += GUID_BATCH_SIZE) {
    const batch = ratingKeys.slice(i, i + GUID_BATCH_SIZE);
    const path = `/library/metadata/${batch.join(",")}`;
    const body = await fetchPlexJson(`${ctx.connectionUri}${path}`, plexHeaders(ctx.clientIdentifier, { "X-Plex-Token": ctx.token }));
    const container = (body as { MediaContainer?: { Metadata?: RawPlexVideo[] | RawPlexVideo } }).MediaContainer;
    for (const item of coerceArray(container?.Metadata)) {
      const ratingKey = coerceString(item.ratingKey);
      if (ratingKey) result.set(ratingKey, extractExternalIds(item));
    }
  }
  return result;
}

export interface ScanResult {
  items: NormalizedPlexItem[];
  /** Whether `includeGuids=1` was confirmed to populate `Guid` children on
   *  the scan itself. Recorded so the caller can log/report which of the two
   *  constraint-7 strategies actually worked against this PMS — see the
   *  Phase 2 report; this could not be verified against a live server during
   *  development, only against fixtures, so it's surfaced rather than
   *  silently assumed. */
  includeGuidsWorked: boolean;
}

async function scanAndResolve(
  ctx: FetchCtx,
  buildPath: (start: number, size: number, includeGuids: boolean) => string,
): Promise<ScanResult> {
  const rawItems: RawPlexVideo[] = [];
  let includeGuidsWorked: boolean | null = null;

  for await (const page of paginate((start, size) =>
    fetchOnePage(ctx, buildPath(start, size, includeGuidsWorked !== false)),
  )) {
    rawItems.push(...page);
    if (includeGuidsWorked === null) {
      // Probe the first non-empty page: did includeGuids=1 actually attach
      // Guid children to modern-agent items? (Legacy-agent items never have
      // Guid children regardless, so we specifically look for *any* item
      // with a populated Guid array as proof the parameter had an effect.)
      includeGuidsWorked = page.some((it) => coerceArray(it.Guid).length > 0);
    }
  }

  const items = rawItems.map(normalizePlexVideo).filter((i): i is NormalizedPlexItem => i !== null);

  if (includeGuidsWorked === false) {
    const unresolved = rawItems.filter(needsGuidResolution);
    if (unresolved.length > 0) {
      const ratingKeys = unresolved
        .map((it) => coerceString(it.ratingKey))
        .filter((k): k is string => !!k);
      const resolved = await resolveGuidsViaBatch(ratingKeys, ctx);
      for (const item of items) {
        const fallback = resolved.get(item.ratingKey);
        if (fallback && item.externalIds.tmdbId === null) {
          item.externalIds = fallback;
        }
      }
    }
  }

  return { items, includeGuidsWorked: includeGuidsWorked ?? false };
}

export async function scanWatchedMovies(ctx: FetchCtx, sectionKey: string): Promise<ScanResult> {
  return scanAndResolve(ctx, (start, size, includeGuids) => buildWatchedMoviesPath(sectionKey, start, size, includeGuids));
}

export async function scanWatchedEpisodes(ctx: FetchCtx, sectionKey: string): Promise<ScanResult> {
  return scanAndResolve(ctx, (start, size, includeGuids) => buildWatchedEpisodesPath(sectionKey, start, size, includeGuids));
}

/** All shows in a section (not just watched ones) — needed for
 *  leafCount/viewedLeafCount, which only live on the show/season item
 *  itself, not on individual episodes. */
export async function scanAllShows(ctx: FetchCtx, sectionKey: string): Promise<NormalizedPlexItem[]> {
  const rawItems: RawPlexVideo[] = [];
  for await (const page of paginate((start, size) => fetchOnePage(ctx, buildAllShowsPath(sectionKey, start, size)))) {
    rawItems.push(...page);
  }
  return rawItems.map(normalizePlexVideo).filter((i): i is NormalizedPlexItem => i !== null);
}
