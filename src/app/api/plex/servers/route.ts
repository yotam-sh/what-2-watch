// GET /api/plex/servers — lists every Plex server discovered for the
// caller's account (owned and shared alike) for the Settings server picker:
// name, owned-vs-shared, whether it's currently selected, and whether it's
// reachable right now.
//
// Reachability is a live /identity race per server (resources.ts's
// selectBestConnection — the exact same constraint-12 race a sync would do,
// just run here for display instead of to actually pick a connection to
// use), run concurrently across every discovered server so this route's
// total latency is about one server's worth of probing, not N servers'.
//
// Deliberately read-only: it does NOT persist the "exactly one server ->
// auto-select" rule as a side effect of a GET (see listServersForPicker's
// doc comment in link.ts) — the client infers "no picker needed" itself
// from `servers.length <= 1`, and the actual plex_selected_servers row gets
// written lazily by getLinkedServerContext(s) the first time a real
// connection is needed.
import { NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { listServersForPicker, PlexNotLinkedError } from "@/lib/plex/link";
import { selectBestConnection } from "@/lib/plex/resources";
import { VaultKeyUnavailableError } from "@/lib/plex/token";

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
    const { servers, selectedMachineIdentifiers, token } = await listServersForPicker(user.id);

    const withReachability = await Promise.all(
      servers.map(async (server) => ({
        machineIdentifier: server.clientIdentifier,
        name: server.name,
        owned: server.owned,
        // A lone server counts as selected even before the first sync has
        // lazily persisted that row — matches "exactly one server -> no
        // picker, auto-selected" holding true the moment it's discovered.
        selected: selectedMachineIdentifiers.has(server.clientIdentifier) || servers.length === 1,
        reachable: (await selectBestConnection(server.connections, token)) !== null,
      })),
    );

    return NextResponse.json({
      servers: withReachability,
      needsSelection: servers.length > 1 && selectedMachineIdentifiers.size === 0,
    });
  } catch (err) {
    if (err instanceof PlexNotLinkedError) {
      return NextResponse.json({ error: "Plex is not linked." }, { status: 400 });
    }
    if (err instanceof VaultKeyUnavailableError) {
      return NextResponse.json({ error: "Session expired." }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Failed to list Plex servers.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
