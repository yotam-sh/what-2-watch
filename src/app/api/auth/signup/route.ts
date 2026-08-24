// POST /api/auth/signup — creates a user, derives their userVault key from
// the password they just typed (while it's still available in plaintext),
// and immediately establishes a session so they land logged in.
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getClientIp } from "@/lib/auth/clientIp";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/cookies";
import { signSessionToken } from "@/lib/auth/jwt";
import { hashPassword } from "@/lib/auth/password";
import { SlidingWindowRateLimiter } from "@/lib/auth/rateLimit";
import { createSession } from "@/lib/auth/sessionStore";
import { deriveUserVaultKey, generateKdfSalt } from "@/lib/crypto/userVault";

// Independent from the login limiter per the plan — a burst of signups
// should never lock out an existing user trying to log in.
const signupLimiter = new SlidingWindowRateLimiter(5, 60_000);

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: NextRequest) {
  if (!signupLimiter.check(getClientIp(request))) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again in a minute." },
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
    return NextResponse.json({ error: "username and password are required." }, { status: 400 });
  }

  const trimmedUsername = username.trim();
  if (!USERNAME_RE.test(trimmedUsername)) {
    return NextResponse.json(
      { error: "Username must be 3-32 characters: letters, numbers, underscore, or hyphen." },
      { status: 400 },
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const existing = db.select().from(users).where(eq(users.username, trimmedUsername)).get();
  if (existing) {
    return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
  }

  const kdfSalt = generateKdfSalt();
  // Both are expensive Argon2id passes but derive independent outputs from
  // independent salts (see users.kdf_salt comment in schema.ts) — run them
  // concurrently rather than paying the cost twice in sequence.
  const [passwordHash, vaultKey] = await Promise.all([
    hashPassword(password),
    deriveUserVaultKey(password, kdfSalt),
  ]);

  const user = db
    .insert(users)
    .values({ username: trimmedUsername, passwordHash, kdfSalt })
    .returning()
    .get();

  const sid = createSession(user.id, vaultKey);
  const token = await signSessionToken({ sub: user.id, username: user.username, sid });

  const response = NextResponse.json({ ok: true, username: user.username }, { status: 201 });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  return response;
}
