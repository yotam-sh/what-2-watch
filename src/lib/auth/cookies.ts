// Session cookie name + flags, defined once so the routes that set it and
// the guards that read it can't drift apart.
import { env } from "@/lib/env";

export const SESSION_COOKIE_NAME = "session_token";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days — matches the JWT expiry in jwt.ts

// `secure` must be false for local http:// dev (browsers silently drop
// secure cookies over plain http) and true once this sits behind the
// Cloudflare Tunnel in production — controlled by SECURE_COOKIES, not
// NODE_ENV, since "production build running locally over http" is a real
// case this app needs to support. Shape matches the options object accepted
// by both NextResponse#cookies.set and next/headers' cookies().set.
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.SECURE_COOKIES,
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
};
