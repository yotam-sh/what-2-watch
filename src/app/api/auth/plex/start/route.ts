// POST /api/auth/plex/start — mints a Plex PIN for the "Sign in with Plex"
// landing-page flow. Unauthenticated by design: Plex login *is* how a
// session gets created here, so this can't require one already existing.
//
// Always mints a fresh client identifier (see src/lib/plex/account.ts for
// why: at this point we don't yet know which account — new or returning —
// is about to sign in, so there's no existing plex_links row to look one up
// from). Rate-limited per IP, independently from every other limiter, per
// the plan's "rate-limit signup, login, and PIN creation independently" —
// this route is now the merge of all three.
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/auth/clientIp";
import { PLEX_PIN_COOKIE_NAME, plexPinCookieOptions } from "@/lib/auth/plexPinCookie";
import { SlidingWindowRateLimiter } from "@/lib/auth/rateLimit";
import { generateClientIdentifier } from "@/lib/plex/headers";
import { buildAuthUrl, createPin } from "@/lib/plex/pin";

const startLimiter = new SlidingWindowRateLimiter(5, 60_000);

export async function POST(request: NextRequest) {
  if (!startLimiter.check(getClientIp(request))) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please try again in a minute." },
      { status: 429 },
    );
  }

  const clientIdentifier = generateClientIdentifier();
  const pin = await createPin(clientIdentifier);
  // Forward into the dedicated popup-closer page, not "/" — this URL is
  // where the *popup* ends up after the user authorises, and the popup has
  // no session cookie of its own yet (the original tab is the one polling
  // /api/auth/plex/poll and getting the session). Landing the popup on "/"
  // used to render it logged-out; plex-auth-callback instead posts a
  // message to the opener and closes itself. See PlexSignInCard.tsx.
  const forwardUrl = `${request.nextUrl.origin}/plex-auth-callback`;
  const authUrl = buildAuthUrl({ clientIdentifier, code: pin.code, forwardUrl });

  const response = NextResponse.json({ authUrl, expiresIn: pin.expiresIn });
  response.cookies.set(
    PLEX_PIN_COOKIE_NAME,
    JSON.stringify({ pinId: pin.id, code: pin.code, clientIdentifier }),
    plexPinCookieOptions(pin.expiresIn),
  );
  return response;
}
