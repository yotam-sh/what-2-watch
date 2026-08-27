// ---------------------------------------------------------------------------
// Watched-state sync via library scans.
//
// CONSTRAINT 5: prefer library scans over /status/sessions/history/all,
// which gives only `viewedAt` + identity — no duration, no completion state.
// `/library/sections/{id}/all?type=1&viewCount>=1&sort=lastViewedAt:desc`
// returns current state (viewCount, lastViewedAt, viewOffset) in one
// paginated call. The movie/episode scan paths below are built as literal
// strings rather than URLSearchParams, which would encode `>` and `=`
// inconsistently depending on whether they land in a key or a value.
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
//
// Live evidence (first real sync, 2026-08-24): a real PMS build 400'd on the
// full default request. Bug A (see mediaContainer.ts) was the reason every
// scan came back with zero items even once a request *was* accepted — the
// page-extraction code was reading a MediaContainer key this server never
// populated. Bug B: the `%3E%3D`-encoded `viewCount>=1` filter is *itself*
// rejected by this PMS build — the live ladder showed rungs 1, 2, and 3 all
// 400 (all three still carried the encoded filter), and only the rung that
// dropped the filter entirely succeeded. `%3E%3D` was originally chosen
// because it's how a browser/fetch would encode a literal `>=` if you let
// the URL serializer do it — but Plex's own filter-query parsing does not
// URL-decode query parameter *names*, so a request with `viewCount%3E%3D1`
// arrives as a parameter literally named that (no decoded `>=` operator to
// recognize) and gets rejected. A **literal, un-encoded** `>=` is what
// PMS's filter parser actually wants — see buildWatchedMoviesPath /
// buildWatchedEpisodesPath's `viewCountFilter: "raw"` mode and
// fetchPlexJsonRawPath in http.ts (fetch() itself cannot send a raw `>` in
// a query string; that function bypasses fetch() specifically so it can).
//
// `includeGuids=1` and the 1000-item page size remain separate
// version-dependent unknowns on top of that. Rather than guess which axis
// a given server rejects, `scanAndResolve`'s degradation ladder (see the
// SCAN_VARIANTS block below the pagination helpers) retries the *first
// page only* with progressively more conservative variants until one is
// accepted, then reuses that variant for the rest of the scan.
// ---------------------------------------------------------------------------

// NOTE: this file deliberately has NO import of "@/db/client" or any Drizzle
// schema table. Every function here is pure or does network I/O only, so
// unit tests can import it (for the pure functions) without ever opening the
// real on-disk SQLite database. The DB-writing orchestration that consumes
// these functions lives in librarySync.ts.

import { plexHeaders } from "./headers";
import { extractExternalIds, needsGuidResolution, type ExternalIds, type GuidBearingItem } from "./guid";
import { fetchPlexJson, fetchPlexJsonRawPath, PlexRequestError } from "./http";
import { extractMediaContainerItems, type MediaContainerLike } from "./mediaContainer";
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
  duration?: unknown;
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
  /** Total runtime in milliseconds, as Plex reports it. Needed to turn a
   *  raw viewOffset into a completion *fraction* — 4% watched and 95%
   *  watched are both "stopped early" without it. */
  duration?: number;
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
    duration: coerceInt(raw.duration),
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
 *  clamped to MAX_CONTAINER_SIZE regardless of what's requested (or lower,
 *  if the degradation ladder in scanAndResolve settled on a smaller page).
 *  `startAt` lets a caller that already fetched page one itself (as the
 *  ladder does, to discover which request variant this PMS accepts) resume
 *  pagination from where that page left off instead of re-fetching it. */
export async function* paginate<T>(
  fetchPage: (start: number, size: number) => Promise<PlexPage<T>>,
  pageSize: number = MAX_CONTAINER_SIZE,
  startAt: number = 0,
): AsyncGenerator<T[]> {
  const size = Math.min(pageSize, MAX_CONTAINER_SIZE);
  let start = startAt;
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
// Bug B: the `>=` filter operator has two possible wire forms — a literal,
// un-encoded `viewCount>=1` (what PMS's filter parser actually wants) or
// the %3E%3D-encoded form (kept as a fallback rung — see SCAN_VARIANTS).
// Built as literal strings rather than URLSearchParams either way, since
// URLSearchParams would encode `>` and `=` inconsistently depending on
// whether they land in a key or a value.
export type ViewCountFilterMode = "raw" | "encoded" | "none";

function viewCountParam(mode: ViewCountFilterMode): string {
  if (mode === "raw") return "&viewCount>=1";
  if (mode === "encoded") return "&viewCount%3E%3D1";
  return "";
}

export function buildWatchedMoviesPath(
  sectionKey: string,
  start: number,
  size: number,
  includeGuids: boolean,
  viewCountFilter: ViewCountFilterMode = "encoded",
): string {
  const guidParam = includeGuids ? "&includeGuids=1" : "";
  return `/library/sections/${encodeURIComponent(sectionKey)}/all?type=1${viewCountParam(viewCountFilter)}&sort=lastViewedAt:desc${guidParam}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
}

export function buildWatchedEpisodesPath(
  sectionKey: string,
  start: number,
  size: number,
  includeGuids: boolean,
  viewCountFilter: ViewCountFilterMode = "encoded",
): string {
  const guidParam = includeGuids ? "&includeGuids=1" : "";
  return `/library/sections/${encodeURIComponent(sectionKey)}/all?type=4${viewCountParam(viewCountFilter)}${guidParam}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
}

export function buildAllShowsPath(sectionKey: string, start: number, size: number): string {
  return `/library/sections/${encodeURIComponent(sectionKey)}/all?type=2&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
}

/** Full-library movie scan path (Phase 6 "discover pool"): every movie in the
 *  section, watched or not — deliberately no viewCount param at all, in any
 *  wire form. Mirrors buildAllShowsPath's "no filter" shape rather than
 *  buildWatchedMoviesPath's optional-filter shape, since a full scan never
 *  wants the filter, not even as a fallback. Still supports includeGuids and
 *  pagination like the watched-movies path, since those two axes are
 *  orthogonal to whether a viewCount filter is present — the same
 *  degradation ladder (varying size/includeGuids) applies either way. Sorted
 *  by titleSort for stable pagination ordering across requests (unlike
 *  buildAllShowsPath, a full movie library is large enough that page-to-page
 *  ordering stability actually matters). */
export function buildAllMoviesPath(sectionKey: string, start: number, size: number, includeGuids: boolean): string {
  const guidParam = includeGuids ? "&includeGuids=1" : "";
  return `/library/sections/${encodeURIComponent(sectionKey)}/all?type=1&sort=titleSort${guidParam}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
}

export interface FetchCtx {
  connectionUri: string;
  token: string;
  clientIdentifier: string;
}

/** `useRawTransport` routes through fetchPlexJsonRawPath instead of
 *  fetchPlexJson — required (not optional) whenever `path` carries a raw,
 *  un-encoded `>` (bug B): fetch()/the WHATWG URL parser would silently
 *  percent-encode it back to `%3E`, reproducing the exact rejection this
 *  path exists to avoid. See http.ts's fetchPlexJsonRawPath for the wire-
 *  level proof. */
async function fetchOnePage(
  ctx: FetchCtx,
  path: string,
  useRawTransport = false,
): Promise<{ items: RawPlexVideo[]; totalSize: number }> {
  const headers = plexHeaders(ctx.clientIdentifier, { "X-Plex-Token": ctx.token });
  const body = useRawTransport
    ? await fetchPlexJsonRawPath(ctx.connectionUri, path, headers)
    : await fetchPlexJson(`${ctx.connectionUri}${path}`, headers);
  const container = (body as { MediaContainer?: MediaContainerLike & { totalSize?: unknown; size?: unknown } }).MediaContainer;
  // Bug A: this used to read `container?.Video ?? container?.Directory`
  // directly, which silently produced [] against a PMS build that returns
  // items under `.Metadata` (HTTP 200, no error anywhere — just zero
  // items). Goes through the shared constraint-14 guard now.
  const items = extractMediaContainerItems(container) as RawPlexVideo[];
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
    const container = (body as { MediaContainer?: MediaContainerLike }).MediaContainer;
    // Symmetric fix to fetchOnePage above: this batched-lookup response is
    // usually keyed under `.Metadata`, but a server that returns `.Video`
    // here instead would break the same way bug A did. Same shared guard.
    for (const item of extractMediaContainerItems(container) as RawPlexVideo[]) {
      const ratingKey = coerceString(item.ratingKey);
      if (ratingKey) result.set(ratingKey, extractExternalIds(item));
    }
  }
  return result;
}

// ---- degradation ladder (constraint 9 / includeGuids / viewCount-filter) --
// Three parameters in the watched-scan request are version-dependent
// unknowns that can each cause a PMS to reject the request outright with a
// 400, not merely ignore it: `includeGuids=1` support varies by build; some
// builds cap X-Plex-Container-Size below 1000; and the viewCount filter may
// not be accepted in every wire form either. Rather than guess which one a
// given server rejects, try progressively more conservative variants — on
// the *first page only* — until one succeeds, then reuse that same variant
// for every remaining page without re-probing.
//
// Bug B live evidence: the %3E%3D-encoded filter was rejected outright (400
// on every rung that carried it, regardless of includeGuids/size), and only
// dropping the filter entirely worked. The *literal*, un-encoded
// `viewCount>=1` is what PMS's filter parser actually wants — see this
// file's header comment and fetchPlexJsonRawPath in http.ts. So the raw
// form is tried first, varying includeGuids/size same as before (rungs
// 1-3); then, since live evidence showed the old no-includeGuids/size-100
// rungs don't help when the filter itself is the problem, the ladder skips
// straight to the original all-defaults encoded-filter request in case some
// other server build wants that specific wire form (rung 4, "some builds
// may want it"); then finally the guaranteed-correct floor that drops the
// filter and filters client-side instead (rung 5).
export type ScanVariantName =
  | "raw-filter"
  | "raw-filter-no-includeGuids"
  | "raw-filter-size-100"
  | "encoded-filter"
  | "no-viewCount-filter";

interface ScanVariant {
  name: ScanVariantName;
  size: number;
  includeGuids: boolean;
  viewCountFilter: ViewCountFilterMode;
}

const SCAN_VARIANTS: ScanVariant[] = [
  { name: "raw-filter", size: MAX_CONTAINER_SIZE, includeGuids: true, viewCountFilter: "raw" },
  { name: "raw-filter-no-includeGuids", size: MAX_CONTAINER_SIZE, includeGuids: false, viewCountFilter: "raw" },
  { name: "raw-filter-size-100", size: 100, includeGuids: false, viewCountFilter: "raw" },
  { name: "encoded-filter", size: MAX_CONTAINER_SIZE, includeGuids: true, viewCountFilter: "encoded" },
  { name: "no-viewCount-filter", size: 100, includeGuids: false, viewCountFilter: "none" },
];

/** Thrown only when every rung of the degradation ladder 400s on the first
 *  page — this PMS build is rejecting something about the request that this
 *  app doesn't have a further fallback for. */
export class PlexScanFailedError extends Error {
  constructor(attempted: ScanVariantName[]) {
    super(
      `Plex library scan failed on every request variant this app knows how to try ` +
        `(tried: ${attempted.join(", ")}). This PMS build is rejecting something about the ` +
        `request (includeGuids, container size, or the viewCount filter) that couldn't be worked around.`,
    );
    this.name = "PlexScanFailedError";
  }
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
  /** Which degradation-ladder variant this PMS actually accepted — surfaced
   *  end-to-end into the /api/plex/sync response so the user learns what
   *  their server build actually supports. */
  variantUsed: ScanVariantName;
}

export interface ScanAndResolveOptions {
  /** Whether the caller wants a viewCount filter applied at all. Default
   *  true (watched-only scans). false is the full-library-scan shape: the
   *  filter is never sent, on any rung — not even as a last-resort fallback
   *  — and the client-side "keep only viewCount>=1" refilter that the
   *  no-viewCount-filter *fallback* rung normally applies (because that rung
   *  exists to recover a watched-only scan when the server rejects every
   *  wire form of the filter) is skipped entirely, since a caller with
   *  applyFilter:false never wanted filtering in the first place. The
   *  size/includeGuids degradation across SCAN_VARIANTS' rungs still applies
   *  unchanged either way — that axis is orthogonal to the filter. */
  applyFilter?: boolean;
}

async function scanAndResolve(
  ctx: FetchCtx,
  buildPath: (start: number, size: number, includeGuids: boolean, viewCountFilter: ViewCountFilterMode) => string,
  opts: ScanAndResolveOptions = {},
): Promise<ScanResult> {
  const applyFilter = opts.applyFilter ?? true;

  // Walk the ladder against the first page only. A non-400 failure (auth,
  // network, 5xx, ...) isn't something the ladder can fix, so it propagates
  // immediately rather than being masked by trying weaker variants.
  const attempted: ScanVariantName[] = [];
  let variant: ScanVariant | undefined;
  let firstPage: { items: RawPlexVideo[]; totalSize: number } | undefined;
  for (const candidate of SCAN_VARIANTS) {
    attempted.push(candidate.name);
    const effectiveFilter: ViewCountFilterMode = applyFilter ? candidate.viewCountFilter : "none";
    try {
      firstPage = await fetchOnePage(
        ctx,
        buildPath(0, candidate.size, candidate.includeGuids, effectiveFilter),
        effectiveFilter === "raw",
      );
      variant = candidate;
      break;
    } catch (err) {
      if (err instanceof PlexRequestError && err.status === 400) {
        continue; // this PMS build rejects this variant outright — back off to the next rung
      }
      throw err;
    }
  }
  if (!variant || !firstPage) {
    throw new PlexScanFailedError(attempted);
  }

  // Log once per sync (right here, when the working variant is settled) —
  // never per page, since every remaining page below reuses `variant`
  // without re-probing.
  if (variant.name !== "raw-filter") {
    console.warn(
      `[plex/library] server rejected the default library-scan request with 400; ` +
        `falling back to variant "${variant.name}" for the rest of this sync.`,
    );
  }

  const rawItems: RawPlexVideo[] = [...firstPage.items];
  if (firstPage.items.length > 0 && firstPage.items.length < firstPage.totalSize) {
    for await (const page of paginate(
      (start, size) =>
        fetchOnePage(
          ctx,
          buildPath(start, size, variant!.includeGuids, applyFilter ? variant!.viewCountFilter : "none"),
          applyFilter && variant!.viewCountFilter === "raw",
        ),
      variant.size,
      firstPage.items.length,
    )) {
      rawItems.push(...page);
    }
  }

  // The final rung ("no-viewCount-filter") drops the server-side viewCount
  // filter entirely (fetches everything in the section), so a *watched-only*
  // scan (applyFilter: true) must reproduce it client-side here. A caller
  // that never wanted filtering at all (applyFilter: false — the full-scan
  // shape) skips this regardless of which rung settled, since there's
  // nothing to reproduce.
  const filteredRawItems =
    !applyFilter || variant.viewCountFilter !== "none"
      ? rawItems
      : rawItems.filter((it) => (coerceInt(it.viewCount) ?? 0) >= 1);

  const items = filteredRawItems.map(normalizePlexVideo).filter((i): i is NormalizedPlexItem => i !== null);

  // If includeGuids was never even sent (dropped by rung 2+), it definitely
  // didn't populate Guid children — no need to probe. Otherwise, probe the
  // first page for proof it actually had an effect (legacy-agent items never
  // carry Guid children regardless of the parameter).
  const includeGuidsWorked = variant.includeGuids
    ? firstPage.items.some((it) => coerceArray(it.Guid).length > 0)
    : false;

  if (!includeGuidsWorked) {
    const unresolved = filteredRawItems.filter(needsGuidResolution);
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

  return { items, includeGuidsWorked, variantUsed: variant.name };
}

export async function scanWatchedMovies(ctx: FetchCtx, sectionKey: string): Promise<ScanResult> {
  return scanAndResolve(ctx, (start, size, includeGuids, viewCountFilter) =>
    buildWatchedMoviesPath(sectionKey, start, size, includeGuids, viewCountFilter),
  );
}

export async function scanWatchedEpisodes(ctx: FetchCtx, sectionKey: string): Promise<ScanResult> {
  return scanAndResolve(ctx, (start, size, includeGuids, viewCountFilter) =>
    buildWatchedEpisodesPath(sectionKey, start, size, includeGuids, viewCountFilter),
  );
}

/** Full-library movie scan (Phase 6 "discover pool"): every movie in the
 *  section, watched or not — see buildAllMoviesPath. Reuses scanAndResolve's
 *  degradation ladder with applyFilter:false rather than a parallel fetch
 *  path, so the same includeGuids/container-size probing (and the same
 *  guid-resolution fallback) that was hard-won against a real server for the
 *  watched scans applies here too. */
export async function scanAllMovies(ctx: FetchCtx, sectionKey: string): Promise<ScanResult> {
  return scanAndResolve(
    ctx,
    (start, size, includeGuids) => buildAllMoviesPath(sectionKey, start, size, includeGuids),
    { applyFilter: false },
  );
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
