// POST /api/plex/play — start playback of a title on a Plex client.
// DELETE /api/plex/play — stop playback on a client.
//
// POST returns as soon as the command is sent, NOT when playback confirms.
// Confirmation takes ~8 seconds and is only observable in the server's
// session list (see src/lib/plex/player.ts), so holding the request open for
// it would reintroduce exactly the long-blocking-request problem the sync
// rewrite existed to remove. The client polls GET /api/plex/play/status.
//
// DELETE is not optional garnish. A confirmation poll that times out has NOT
// necessarily failed — it may be a slow success — so the caller stops the
// player before reporting failure. An orphaned stream burns a transcode slot
// and eventually writes a watch event for a film nobody watched, which
// corrupts the taste model. This happened for real during development.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { PlaybackError, startPlayback, stopPlayback } from "@/lib/plex/player";

async function authed() {
  try {
    return { user: await requireUser(), response: null as null };
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return { user: null, response: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
    }
    throw err;
  }
}

export async function POST(request: NextRequest) {
  const { user, response } = await authed();
  if (!user) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { tmdbId, mediaType, playerMachineIdentifier } = (body ?? {}) as Record<string, unknown>;
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId)) {
    return NextResponse.json({ error: "tmdbId must be an integer." }, { status: 400 });
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    return NextResponse.json({ error: "mediaType must be 'movie' or 'tv'." }, { status: 400 });
  }
  if (typeof playerMachineIdentifier !== "string" || playerMachineIdentifier.length === 0) {
    return NextResponse.json({ error: "playerMachineIdentifier is required." }, { status: 400 });
  }

  try {
    const { ratingKey } = await startPlayback({
      userId: user.id,
      tmdbId,
      mediaType,
      playerMachineIdentifier,
    });
    // `sent`, deliberately — not `started`. Nothing is known yet.
    return NextResponse.json({ sent: true, ratingKey });
  } catch (err) {
    if (err instanceof PlaybackError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(request: NextRequest) {
  const { user, response } = await authed();
  if (!user) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { playerMachineIdentifier } = (body ?? {}) as Record<string, unknown>;
  if (typeof playerMachineIdentifier !== "string" || playerMachineIdentifier.length === 0) {
    return NextResponse.json({ error: "playerMachineIdentifier is required." }, { status: 400 });
  }

  try {
    await stopPlayback(user.id, playerMachineIdentifier);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PlaybackError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
