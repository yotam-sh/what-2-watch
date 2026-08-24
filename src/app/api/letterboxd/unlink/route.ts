// POST /api/letterboxd/unlink — removes the stored Letterboxd link.
// Deliberately scoped to the link only: previously synced watch_events rows
// are left in place (same as Plex's unlink — see src/app/api/plex/unlink).
// Full account deletion cascades everything, per schema.ts.
import { NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { unlinkLetterboxdAccount } from "@/lib/letterboxd/sync";

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    throw err;
  }

  unlinkLetterboxdAccount(user.id);
  return NextResponse.json({ ok: true });
}
