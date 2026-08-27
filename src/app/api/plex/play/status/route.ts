// GET /api/plex/play/status?ratingKey=… — is this title actually playing?
//
// The only honest answer to "did the play command work". The command's own
// HTTP response is byte-identical for success, a nonexistent ratingKey and a
// malformed one (`"Failure: 200 OK"` every time), so it carries no
// information at all — the server's session list is the sole ground truth.
// See the findings block in src/lib/plex/player.ts.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { isPlaying } from "@/lib/plex/player";

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    throw err;
  }

  const ratingKey = request.nextUrl.searchParams.get("ratingKey");
  if (!ratingKey) {
    return NextResponse.json({ error: "ratingKey is required." }, { status: 400 });
  }

  try {
    return NextResponse.json({ playing: await isPlaying(user.id, ratingKey) });
  } catch {
    // A failed probe is "don't know yet", not "not playing" — the caller is
    // polling and will ask again.
    return NextResponse.json({ playing: false, unknown: true });
  }
}
