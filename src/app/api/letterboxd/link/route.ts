// POST /api/letterboxd/link — links a Letterboxd username to the caller's
// account. Validates the username against Letterboxd's real character set
// locally (fail fast) and then fetches the RSS feed once to confirm the
// account actually exists (turns a typo into an immediate, actionable error
// instead of a link that silently never syncs). Kicks off an initial sync
// with that same fetch, best-effort — the link itself has already succeeded
// by that point, so a sync hiccup (e.g. TMDB enrichment failing on the
// placeholder dev key) must not turn into a failed link response.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import {
  InvalidLetterboxdUsernameError,
  LetterboxdFetchError,
  LetterboxdUserNotFoundError,
} from "@/lib/letterboxd/rss";
import { linkLetterboxdAccount, syncLetterboxdForUser } from "@/lib/letterboxd/sync";

export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { username } = (body ?? {}) as { username?: unknown };
  if (typeof username !== "string") {
    return NextResponse.json({ error: "username is required." }, { status: 400 });
  }
  const trimmed = username.trim();

  try {
    await linkLetterboxdAccount(user.id, trimmed);
  } catch (err) {
    if (err instanceof InvalidLetterboxdUsernameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof LetterboxdUserNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof LetterboxdFetchError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  let newEntries = 0;
  try {
    const result = await syncLetterboxdForUser(user.id);
    newEntries = result.newEntries;
  } catch {
    // Link succeeded; the failed initial sync is already recorded in
    // sync_state by syncLetterboxdForUser and can be retried via
    // POST /api/letterboxd/sync.
  }

  return NextResponse.json({ ok: true, username: trimmed, newEntries }, { status: 201 });
}
