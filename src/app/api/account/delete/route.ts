// POST /api/account/delete — permanently deletes the caller's account.
//
// This route doesn't exist in any earlier phase (Phases 1-3/5/6 never needed
// it), and the Phase 4 brief requires it, so it's new application code
// composed entirely from already-shipped lib modules (db, users,
// verifyPassword, destroySession, clearPendingPin, the session cookie
// helpers) rather than a change to any of them.
//
// Requires re-entering the password: this is a one-way destructive action
// (schema.ts cascades every table off `users.id`), so it gets the same bar
// as changing a password would elsewhere — a live session cookie alone
// (which could be a stale tab, a CSRF-adjacent slip, etc.) isn't enough
// confirmation for something unrecoverable.
//
// Per the plan's security section: "with per-user-key encryption, a
// forgotten password means the Plex token is unrecoverable by design; the UI
// must say so before the user sets it." Deletion is the same shape of
// one-way door — the UI (SettingsScreen.tsx) states that plainly in the
// confirmation copy before this route is ever called.
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { verifyPassword } from "@/lib/auth/password";
import { destroySession } from "@/lib/auth/sessionStore";
import { clearPendingPin } from "@/lib/plex/pinSession";

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

  const { password } = (body ?? {}) as { password?: unknown };
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "Enter your password to confirm account deletion." }, { status: 400 });
  }

  const row = db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) {
    // Already gone (e.g. a second deletion request racing the first) —
    // treat as success rather than a confusing error.
    return NextResponse.json({ ok: true });
  }

  const validPassword = await verifyPassword(row.passwordHash, password);
  if (!validPassword) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  // Cascades plex_links, letterboxd_links, titles-referencing rows scoped to
  // this user (plex_items, watch_events, watchlist_items, interactions,
  // cf_user_factors, ltr_models, sync_state) — every FK in schema.ts that
  // references users.id is ON DELETE CASCADE.
  db.delete(users).where(eq(users.id, user.id)).run();

  destroySession(user.sid);
  clearPendingPin(user.id);

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
