// POST /api/recommend/feedback — records the user's verdict on a previously
// shown candidate ('picked' | 'skipped' | 'snoozed'). This, together with
// the 'shown' rows POST /api/recommend writes, is the entire training set
// ltr.ts's updateLtrModelForUser() (and part of cf.ts's signal) consumes.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { recordFeedback, type FeedbackAction } from "@/lib/ml/feedback";

const VALID_ACTIONS: FeedbackAction[] = ["picked", "skipped", "snoozed"];

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

  const { tmdbId, mediaType, action, context } = (body ?? {}) as Record<string, unknown>;

  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId)) {
    return NextResponse.json({ error: "tmdbId must be an integer." }, { status: 400 });
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    return NextResponse.json({ error: "mediaType must be 'movie' or 'tv'." }, { status: 400 });
  }
  if (typeof action !== "string" || !VALID_ACTIONS.includes(action as FeedbackAction)) {
    return NextResponse.json({ error: `action must be one of ${VALID_ACTIONS.join(", ")}.` }, { status: 400 });
  }

  try {
    recordFeedback(
      user.id,
      tmdbId,
      mediaType,
      action as FeedbackAction,
      context && typeof context === "object" ? context : undefined,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "Failed to record feedback.", detail: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
