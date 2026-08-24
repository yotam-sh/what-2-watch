// POST /api/letterboxd/sync — runs an on-demand sync for the caller's linked
// Letterboxd account. Synchronous, matching Phase 2's /api/plex/sync — no
// background job scheduler yet, acceptable at this app's scale per the plan.
import { NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { LetterboxdFetchError, LetterboxdUserNotFoundError } from "@/lib/letterboxd/rss";
import { LetterboxdNotLinkedError, syncLetterboxdForUser } from "@/lib/letterboxd/sync";

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    throw err;
  }

  try {
    const result = await syncLetterboxdForUser(user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LetterboxdNotLinkedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof LetterboxdUserNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof LetterboxdFetchError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : "Unknown sync error";
    return NextResponse.json({ error: "Sync failed.", detail: message }, { status: 500 });
  }
}
