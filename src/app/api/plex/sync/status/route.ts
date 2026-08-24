// GET /api/plex/sync/status — reports the caller's current (or most recent)
// background sync job: idle | running | completed | failed, plus progress
// while running and final counts/error once it settles. See
// src/lib/plex/syncJob.ts for the in-memory job registry this reads —
// including why it's fine that a job is lost on container restart (the
// durable outcome lives in sync_state, not here).
import { NextResponse } from "next/server";
import { getOptionalUser } from "@/lib/auth/guards";
import { getSyncJob } from "@/lib/plex/syncJob";

export async function GET() {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  return NextResponse.json(getSyncJob(user.id));
}
