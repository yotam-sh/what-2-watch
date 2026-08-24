// POST /api/plex/servers/selection — replaces the caller's Plex server
// selection wholesale. Body: { machineIdentifiers: string[] }.
//
// This is the only write path onto plex_selected_servers a user directly
// controls (the other write path, auto-selecting a lone server, happens
// implicitly inside getLinkedServerContexts — see link.ts). Validation
// (must be a real server on this account, must not be empty) lives in
// setSelectedServers itself; this route is a thin HTTP-shape wrapper, same
// convention as every other route in this app.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { InvalidServerSelectionError, PlexNotLinkedError, setSelectedServers } from "@/lib/plex/link";
import { VaultKeyUnavailableError } from "@/lib/plex/token";

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

  const { machineIdentifiers } = (body ?? {}) as { machineIdentifiers?: unknown };
  if (!Array.isArray(machineIdentifiers) || !machineIdentifiers.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "machineIdentifiers must be an array of strings." }, { status: 400 });
  }

  try {
    await setSelectedServers(user.id, machineIdentifiers);
  } catch (err) {
    if (err instanceof InvalidServerSelectionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof PlexNotLinkedError) {
      return NextResponse.json({ error: "Plex is not linked." }, { status: 400 });
    }
    if (err instanceof VaultKeyUnavailableError) {
      return NextResponse.json({ error: "Session expired." }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Failed to update server selection.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
