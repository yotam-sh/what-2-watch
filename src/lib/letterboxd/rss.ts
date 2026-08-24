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
// allowance): the feed is exactly 100 <item>s — 50 with a
// `letterboxd-watch-` guid (diary entries, carrying the letterboxd:/tmdb:
// fields) and 50 with a `letterboxd-list-` guid (list stubs, carrying
// neither). Of the 50 diary entries, 34 had `letterboxd:memberRating` and 16
// did not — confirming constraint 19 (absent, not zero, when unrated) against
// real data, not just the spec.
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

const DIARY_GUID_PREFIX = "letterboxd-watch-";
// Constraint 18: the feed's 100 items are 50 diary + 50 list stubs, and
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
 *  Skips:
 *   - list-stub items (`letterboxd-list-` guid prefix, or any guid that
 *     isn't the diary prefix) — they carry no letterboxd:/tmdb: fields.
 *   - diary items missing both `tmdb:movieId` and `tmdb:tvId` — can't be
 *     joined to a title, so silently dropped rather than crashing the sync.
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
    if (!guid.startsWith(DIARY_GUID_PREFIX)) continue; // list stub or unrecognized

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
    if (tmdbId === undefined || mediaType === undefined) continue; // can't join — skip

    const watchedDateRaw = item["letterboxd:watchedDate"];
    const watchedDate =
      typeof watchedDateRaw === "string" ? new Date(`${watchedDateRaw}T00:00:00Z`) : undefined;
    if (!watchedDate || Number.isNaN(watchedDate.getTime())) continue;

    const filmTitle =
      typeof item["letterboxd:filmTitle"] === "string" ? (item["letterboxd:filmTitle"] as string) : "";
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
      filmTitle: filmTitle || `Unknown (tmdb ${tmdbId})`,
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
