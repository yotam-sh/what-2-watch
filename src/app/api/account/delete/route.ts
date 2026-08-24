// POST /api/account/delete — permanently deletes the caller's account.
//
// Plex-only login (revised 2026-08-24): there is no password any more to
// re-verify before this one-way, cascading action (schema.ts cascades every
// table off `users.id`). The replacement confirmation is typing the
// account's own Plex username back — still a deliberate, can't-fat-finger
// step before something unrecoverable, just sourced from the identity this
// app now actually has instead of a credential it no longer holds.
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";

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

  const { confirmUsername } = (body ?? {}) as { confirmUsername?: unknown };
  if (typeof confirmUsername !== "string" || confirmUsername.trim().length === 0) {
    return NextResponse.json(
      { error: "Type your Plex username to confirm account deletion." },
      { status: 400 },
    );
  }

  const row = db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) {
    // Already gone (e.g. a second deletion request racing the first) —
    // treat as success rather than a confusing error.
    return NextResponse.json({ ok: true });
  }

  if (confirmUsername.trim() !== row.plexUsername) {
    return NextResponse.json({ error: "That doesn't match your Plex username." }, { status: 401 });
  }

  // Cascades plex_links, letterboxd_links, titles-referencing rows scoped to
  // this user (plex_items, watch_events, watchlist_items, interactions,
  // cf_user_factors, ltr_models, sync_state) — every FK in schema.ts that
  // references users.id is ON DELETE CASCADE.
  db.delete(users).where(eq(users.id, user.id)).run();

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
