// ---------------------------------------------------------------------------
// Pure state machine for the Plex PIN sign-in flow — the app's first-run
// experience and, per the phase brief, "the most confusing part". Kept
// framework-free and DOM-free so the expiry/polling logic is unit-testable
// without a browser (see src/lib/ui/pinFlow.test.ts): the component
// (PlexSignInCard.tsx, on the landing page — Plex login IS signup now, so
// this no longer lives in Settings) owns the actual `fetch`/`setInterval`
// calls and just feeds their outcomes in as events.
//
// The 30-minute PIN lifetime from the master plan is a rough figure, not a
// constant to hardcode — the real expiry comes back as `expiresIn` (seconds)
// in POST /api/auth/plex/start's response and must be read from there, per
// the phase brief. This module never assumes a duration; STARTED always
// carries the server's real expiresIn.
// ---------------------------------------------------------------------------

/** Constraint 10: never poll plex.tv faster than 1s. This lives here (not
 *  just as a magic number in the component) so a test can assert the
 *  contract directly rather than trusting the component got it right. */
export const MIN_POLL_INTERVAL_MS = 1000;

export type PinFlowState =
  | { status: "idle" }
  | { status: "starting" }
  // popupBlocked: whether the scripted `window.open()` for the Plex auth
  // popup failed (blocked, or closed before we could navigate it). The
  // component falls back to rendering a plain link the user can click
  // themselves; the poll loop below is unaffected either way — it's the
  // only thing that actually establishes the session.
  | { status: "polling"; authUrl: string; expiresAt: number; popupBlocked: boolean }
  | { status: "linked" }
  | { status: "expired" }
  | { status: "error"; message: string };

export type PinFlowEvent =
  | { type: "START" }
  | { type: "STARTED"; authUrl: string; expiresIn: number; now: number }
  | { type: "START_FAILED"; message: string }
  // The popup either never opened (window.open() returned null / a
  // pre-closed handle) or was closed before the auth URL could be pushed
  // into it. Either way, show the manual fallback link.
  | { type: "POPUP_BLOCKED" }
  | { type: "POLL_PENDING" }
  | { type: "POLL_LINKED" }
  | { type: "POLL_ERROR"; message: string }
  | { type: "TICK"; now: number }
  | { type: "RESET" };

export const INITIAL_PIN_FLOW_STATE: PinFlowState = { status: "idle" };

export function pinFlowReducer(state: PinFlowState, event: PinFlowEvent): PinFlowState {
  switch (event.type) {
    case "START":
      return { status: "starting" };
    case "STARTED":
      return {
        status: "polling",
        authUrl: event.authUrl,
        expiresAt: event.now + event.expiresIn * 1000,
        popupBlocked: false,
      };
    case "START_FAILED":
      return { status: "error", message: event.message };
    case "POPUP_BLOCKED":
      // Only meaningful while polling — a stray/late event outside that
      // state (e.g. after the PIN already expired) is a no-op.
      if (state.status !== "polling") return state;
      return { ...state, popupBlocked: true };
    case "POLL_PENDING":
      // Still waiting on the user to finish at app.plex.tv — no state
      // change, just a no-op tick of the poll loop.
      return state;
    case "POLL_LINKED":
      return { status: "linked" };
    case "POLL_ERROR":
      return { status: "error", message: event.message };
    case "TICK":
      // Only a "polling" state can expire; TICK is a no-op in every other
      // state (idle/starting/linked/expired/error).
      if (state.status === "polling" && event.now >= state.expiresAt) {
        return { status: "expired" };
      }
      return state;
    case "RESET":
      return { status: "idle" };
    default:
      return state;
  }
}

export function isPolling(
  state: PinFlowState,
): state is Extract<PinFlowState, { status: "polling" }> {
  return state.status === "polling";
}

/** Milliseconds until the PIN expires, clamped at 0. Null when not currently
 *  polling (nothing to count down). */
export function remainingMs(state: PinFlowState, now: number): number | null {
  if (state.status !== "polling") return null;
  return Math.max(0, state.expiresAt - now);
}

/** The `postMessage` the plex-auth-callback popup sends the opener right
 *  before it closes itself (see src/app/plex-auth-callback/page.tsx). */
export const PLEX_AUTH_COMPLETE_MESSAGE_TYPE = "plex-auth-complete";

/** Whether a `message` event is a trustworthy "the popup finished, go poll
 *  now" hint. Deliberately narrow: `window.postMessage` can be sent by *any*
 *  page that gets a handle to this window, so both the origin and the
 *  payload shape must check out before the component treats it as anything
 *  more than a nudge to poll sooner. This is a hint only, never proof of
 *  auth — POLL_LINKED only ever comes from an actual
 *  /api/auth/plex/poll response, so a forged message can at worst trigger
 *  one extra (harmless, rate-limited) poll. */
export function isTrustedPlexAuthCompleteMessage(
  message: { origin: string; data: unknown },
  expectedOrigin: string,
): boolean {
  if (message.origin !== expectedOrigin) return false;
  const data = message.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === PLEX_AUTH_COMPLETE_MESSAGE_TYPE
  );
}
