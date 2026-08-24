// POST /api/auth/logout — clears the session cookie. There is no in-memory
// half to clear any more (see sessionStore.ts's deletion note in guards.ts's
// file header) — the JWT cookie was the entire session, so removing it is
// the entire logout.
import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
