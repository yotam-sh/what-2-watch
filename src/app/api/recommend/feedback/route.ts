// POST /api/recommend/feedback — records the user's verdict on a previously
// shown candidate ('picked' | 'skipped' | 'snoozed'). This, together with
// the 'shown' rows POST /api/recommend writes, is the entire training set
// ltr.ts's updateLtrModelForUser() (and part of cf.ts's signal) consumes.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { recordFeedback, type FeedbackAction } from "@/lib/ml/feedback";
import { updateLtrModelForUser } from "@/lib/ml/ltr";

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

  // Retrain on the new label. This route's header has claimed since it was
  // written that ltr.ts consumes these rows — it didn't: updateLtrModelForUser
  // appeared nowhere outside its own file except in that comment, so
  // `ltr_models` stayed empty and the ranker never influenced a single roll.
  //
  // Cheap below the threshold: meetsLtrTrainingThreshold() returns early
  // after one COUNT, so this is a no-op until 30 confirmed labels exist.
  // Above it, the work is a taste-context rebuild plus 30 SGD epochs over a
  // few hundred 5-feature examples — milliseconds at a household's data
  // scale. If that ever stops being true, this is the line that moves to a
  // background job, the same way the Plex sync did.
  //
  // Never let training break feedback: a failed retrain must not turn a
  // recorded verdict into a 500 for the user.
  try {
    updateLtrModelForUser(user.id);
  } catch {
    // Swallowed deliberately — the interaction row is already safely written,
    // and the next verdict will retrain anyway.
  }

  return NextResponse.json({ ok: true });
}
