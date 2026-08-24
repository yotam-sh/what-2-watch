// ---------------------------------------------------------------------------
// Letterboxd RSS fetch + parse — the *only* sanctioned way this app talks to
// Letterboxd (constraints 15/16/21 in the plan). No API client, no scraping,
// no watchlist. Everything in this file is a pure function except
// `fetchLetterboxdRssXml`, which is the single network call site — keeping
// parsing pure means the fixtures in rss.test.ts exercise the exact same
// code path production traffic does.
//
// Live-verified 2026-08-21 against https://letterboxd.com/dave/rss/ (an
// unauthenticated, public, sanctioned fetch per the plan's one-time
// allowance): the feed is exactly 100 <item>s — 50 diary entries and 50 list
// stubs. Of the 50 diary entries, 34 had `letterboxd:memberRating` and 16
// did not — confirming constraint 19 (absent, not zero, when unrated) against
// real data, not just the spec.
//
// Re-verified 2026-08-24 against https://letterboxd.com/hesanka/rss/: the
// feed is 51 <item>s, but the diary entries were split across *two* guid
// prefixes — 47 `letterboxd-review-` and 3 `letterboxd-watch-` — plus 1
// `letterboxd-list-` stub. A `letterboxd-review-` item is a diary entry that
// happens to have a review attached; it is structurally identical to a
// `letterboxd-watch-` item otherwise. Earlier code treated
// `letterboxd-watch-` as *the* diary guid prefix and silently dropped every
// reviewed film — wrong, and not fixable by adding a second known prefix,
// since Letterboxd is free to mint others (rewatches, likes, ...) with no
// notice. So diary entries are identified by *shape*, not guid: they carry
// `letterboxd:filmTitle` and a `tmdb:movieId` or `tmdb:tvId`; list stubs
// carry neither. The guid remains only the dedupe key (see
// `selectNewEntries`) — it stays unique and stable across whatever prefix a
// given entry happens to use.
// ---------------------------------------------------------------------------

import { XMLParser } from "fast-xml-parser";

export type LetterboxdMediaType = "movie" | "tv";

export interface LetterboxdDiaryEntry {
  /** RSS <guid>, e.g. "letterboxd-watch-1447297802" — the dedupe key. */
  guid: string;
  tmdbId: number;
  mediaType: LetterboxdMediaType;
  filmTitle: string;
  filmYear?: number;
  watchedDate: Date;
  isRewatch: boolean;
  /** Absent (not 0) when the film is unrated — constraint 19. Never default
   *  this to 0; an unrated film is not a 0-star film. */
  memberRating?: number;
  memberLike?: boolean;
}

// Constraint 18: the feed caps at 50 diary entries (regardless of how many
// distinct guid prefixes they're split across — see file header), and
// `?limit=` is ignored server-side. This slice is a defensive backstop in
// case that ever changes, not the primary mechanism — the primary
// enforcement is simply "the feed only ever contains 50".
const MAX_DIARY_ENTRIES = 50;

// A normal, descriptive UA per the plan ("no auth, no UA restriction") —
// identifies the app and gives Letterboxd an honest way to contact us if
// our traffic pattern is ever a problem, without pretending to be a browser.
const USER_AGENT = "what-to-watch/0.1 (+https://github.com/yotamshavit/what-to-watch; personal movie-night app)";

// Per the official API docs: 2-15 characters, letters/digits/underscore only.
export const LETTERBOXD_USERNAME_PATTERN = /^[A-Za-z0-9_]{2,15}$/;

export class InvalidLetterboxdUsernameError extends Error {
  constructor(username: string) {
    super(
      `"${username}" is not a valid Letterboxd username — usernames are 2-15 characters: ` +
        "letters, numbers, and underscores only.",
    );
    this.name = "InvalidLetterboxdUsernameError";
  }
}

/** Throws InvalidLetterboxdUsernameError for anything outside Letterboxd's
 *  real permitted character set — checked locally so a typo fails fast
 *  instead of round-tripping to a 404. */
export function assertValidLetterboxdUsername(username: string): void {
  if (!LETTERBOXD_USERNAME_PATTERN.test(username)) {
    throw new InvalidLetterboxdUsernameError(username);
  }
}

/** A nonexistent, private, or deactivated Letterboxd user — Letterboxd
 *  returns a plain 404 for all three cases indistinguishably. Callers must
 *  surface this as a clean, actionable message, never an unhandled throw. */
export class LetterboxdUserNotFoundError extends Error {
  constructor(username: string) {
    super(
      `No Letterboxd user found for "${username}". Check the spelling, or the profile may be ` +
        "private or deactivated.",
    );
    this.name = "LetterboxdUserNotFoundError";
  }
}

/** Any non-404 fetch failure (network error, 5xx, unexpected status). */
export class LetterboxdFetchError extends Error {
  readonly status?: number;
  constructor(username: string, status?: number) {
    super(
      status
        ? `Letterboxd RSS fetch failed for "${username}" (HTTP ${status}).`
        : `Letterboxd RSS fetch failed for "${username}".`,
    );
    this.name = "LetterboxdFetchError";
    this.status = status;
  }
}

/** Fetches the raw RSS XML for a Letterboxd user. No auth required
 *  (constraint 16). Validates the username locally first (fail fast, no
 *  round trip for an obviously-bad handle). */
export async function fetchLetterboxdRssXml(username: string): Promise<string> {
  assertValidLetterboxdUsername(username);

  const url = `https://letterboxd.com/${encodeURIComponent(username)}/rss/`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });
  } catch {
    throw new LetterboxdFetchError(username);
  }

  if (response.status === 404) {
    throw new LetterboxdUserNotFoundError(username);
  }
  if (!response.ok) {
    throw new LetterboxdFetchError(username, response.status);
  }
  return response.text();
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  // Force <item> to always parse as an array, even when the feed has a
  // single entry — avoids an Array.isArray branch at every call site.
  isArray: (name) => name === "item",
});

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function yesNoToBoolean(value: unknown): boolean {
  return value === "Yes" || value === true;
}

/** Parses a raw RSS XML string into diary entries only. Deliberately pure
 *  (no network) so fixtures can exercise it in tests.
 *
 *  A diary entry is identified by *shape*, not guid prefix — see the file
 *  header for why: it must carry a non-empty `letterboxd:filmTitle` *and*
 *  either `tmdb:movieId` or `tmdb:tvId`. The guid is kept only as the
 *  dedupe key, never used to classify the item.
 *
 *  Skips:
 *   - list-stub items — they carry neither `letterboxd:filmTitle` nor a
 *     tmdb id, so the shape check filters them out naturally regardless of
 *     which guid prefix they happen to use.
 *   - diary-shaped items missing both `tmdb:movieId` and `tmdb:tvId` — can't
 *     be joined to a title, so silently dropped rather than crashing sync.
 *   - diary items with an unparseable `letterboxd:watchedDate`.
 */
export function parseLetterboxdRss(xml: string): LetterboxdDiaryEntry[] {
  const parsed: unknown = xmlParser.parse(xml);
  const root = parsed as {
    rss?: { channel?: { item?: unknown[] } };
  };
  const rawItems = root.rss?.channel?.item ?? [];

  const entries: LetterboxdDiaryEntry[] = [];
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const guid = typeof item.guid === "string" ? item.guid : "";

    const filmTitleRaw = item["letterboxd:filmTitle"];
    const hasFilmTitle = typeof filmTitleRaw === "string" && filmTitleRaw.trim() !== "";

    const tmdbMovieId = coerceNumber(item["tmdb:movieId"]);
    const tmdbTvId = coerceNumber(item["tmdb:tvId"]);

    let tmdbId: number | undefined;
    let mediaType: LetterboxdMediaType | undefined;
    if (tmdbMovieId !== undefined) {
      tmdbId = tmdbMovieId;
      mediaType = "movie";
    } else if (tmdbTvId !== undefined) {
      tmdbId = tmdbTvId;
      mediaType = "tv";
    }
    // Not diary-shaped (list stub, or any other non-diary item) or can't be
    // joined to a title — skip either way, silently.
    if (!hasFilmTitle || tmdbId === undefined || mediaType === undefined) continue;

    const watchedDateRaw = item["letterboxd:watchedDate"];
    const watchedDate =
      typeof watchedDateRaw === "string" ? new Date(`${watchedDateRaw}T00:00:00Z`) : undefined;
    if (!watchedDate || Number.isNaN(watchedDate.getTime())) continue;

    const filmTitle = filmTitleRaw as string; // hasFilmTitle already proved this is a non-empty string
    const filmYear = coerceNumber(item["letterboxd:filmYear"]);
    const isRewatch = yesNoToBoolean(item["letterboxd:rewatch"]);
    const memberLike =
      item["letterboxd:memberLike"] !== undefined ? yesNoToBoolean(item["letterboxd:memberLike"]) : undefined;
    // Constraint 19: absent, not 0, when unrated.
    const memberRating = coerceNumber(item["letterboxd:memberRating"]);

    entries.push({
      guid,
      tmdbId,
      mediaType,
      filmTitle,
      filmYear,
      watchedDate,
      isRewatch,
      memberRating,
      memberLike,
    });
  }

  return entries.slice(0, MAX_DIARY_ENTRIES);
}

/** Convenience wrapper: fetch + parse in one call. */
export async function fetchLetterboxdDiary(username: string): Promise<LetterboxdDiaryEntry[]> {
  const xml = await fetchLetterboxdRssXml(username);
  return parseLetterboxdRss(xml);
}

/** Given the full parsed diary (feed order: newest first) and the guid
 *  high-water mark from `letterboxd_links.last_guid_seen`, returns only the
 *  entries newer than that mark — still newest-first.
 *
 *  If `lastGuidSeen` is null, this is the first sync: everything currently
 *  in the feed (up to the 50-entry cap) is "new".
 *
 *  If `lastGuidSeen` is set but no longer appears in the feed, the user
 *  logged 50+ films since the last poll and it scrolled out of the window
 *  (constraint 18's accepted gap for infrequent polling) — in that case we
 *  take everything currently present rather than throwing or silently
 *  syncing nothing. */
export function selectNewEntries(
  entries: LetterboxdDiaryEntry[],
  lastGuidSeen: string | null | undefined,
): LetterboxdDiaryEntry[] {
  if (!lastGuidSeen) return entries;
  const idx = entries.findIndex((e) => e.guid === lastGuidSeen);
  return idx === -1 ? entries : entries.slice(0, idx);
}
