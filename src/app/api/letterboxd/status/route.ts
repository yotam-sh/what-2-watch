// GET /api/letterboxd/status — reports whether the caller has a linked
// Letterboxd account and the outcome of its most recent sync.
import { NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { getLetterboxdSyncStatus } from "@/lib/letterboxd/sync";

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

  return NextResponse.json(getLetterboxdSyncStatus(user.id));
}
