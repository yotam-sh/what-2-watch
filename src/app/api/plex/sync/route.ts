// POST /api/plex/sync — starts a background full library + watchlist sync
// for the caller and returns immediately (202) with the job's current
// state. Never awaits the scan itself: see src/lib/plex/syncJob.ts's file
// header for why (a 502-after-5,680ms incident on the first real
// deployment — the previous version of this route held the HTTP request
// open for the entire scan, and cloudflared gave up before the response
// could be sent). One job per user at a time — a second POST while one is
// already running just returns that job (see startOrGetSyncJob).
import { NextResponse } from "next/server";
import { getOptionalUser } from "@/lib/auth/guards";
import { startOrGetSyncJob } from "@/lib/plex/syncJob";

export async function POST() {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const job = startOrGetSyncJob(user);
  return NextResponse.json(job, { status: 202 });
}
