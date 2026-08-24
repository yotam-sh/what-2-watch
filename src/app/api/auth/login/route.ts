// POST /api/auth/login — verifies the password, re-derives the userVault
// key (this is the only place the key can be reconstructed after the
// process's in-memory session store has forgotten it), and starts a session.
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getClientIp } from "@/lib/auth/clientIp";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/cookies";
import { signSessionToken } from "@/lib/auth/jwt";
import { verifyPassword } from "@/lib/auth/password";
import { SlidingWindowRateLimiter } from "@/lib/auth/rateLimit";
import { createSession } from "@/lib/auth/sessionStore";
import { deriveUserVaultKey } from "@/lib/crypto/userVault";

// Independent from the signup limiter per the plan.
const loginLimiter = new SlidingWindowRateLimiter(10, 60_000);

// One generic message for "no such user" and "wrong password" — never tell
// an attacker which half was wrong.
const INVALID_CREDENTIALS = "Invalid username or password.";

export async function POST(request: NextRequest) {
  if (!loginLimiter.check(getClientIp(request))) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again in a minute." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.username, username.trim()))
    .get();
  if (!user) {
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  }

  const validPassword = await verifyPassword(user.passwordHash, password);
  if (!validPassword) {
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  }

  const vaultKey = await deriveUserVaultKey(password, user.kdfSalt);
  const sid = createSession(user.id, vaultKey);
  const token = await signSessionToken({ sub: user.id, username: user.username, sid });

  const response = NextResponse.json({ ok: true, username: user.username });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  return response;
}
