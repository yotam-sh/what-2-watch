// GET /api/plex/players — playback-capable Plex clients currently announcing
// themselves on the user's selected server(s), each annotated with whatever
// it's already playing.
//
// Live list, not a registry: a device that isn't running Plex right now is
// correctly absent, because you cannot cast to a sleeping device. An empty
// list is a normal, expected state — the UI explains the usual cause
// ("Advertise as player" off, or the app needs restarting) rather than
// treating it as an error.
import { NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { listPlayers } from "@/lib/plex/player";

export async function GET() {
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
    return NextResponse.json({ players: await listPlayers(user.id) });
  } catch (err) {
    return NextResponse.json(
      { error: "Couldn't reach your Plex server.", detail: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 },
    );
  }
}
