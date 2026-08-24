// ---------------------------------------------------------------------------
// Pure state machine for the Plex PIN link flow — the app's first-run
// experience and, per the phase brief, "the most confusing part". Kept
// framework-free and DOM-free so the expiry/polling logic is unit-testable
// without a browser (see src/lib/ui/pinFlow.test.ts): the component
// (SettingsScreen.tsx) owns the actual `fetch`/`setInterval` calls and just
// feeds their outcomes in as events.
//
// The 30-minute PIN lifetime from the master plan is a rough figure, not a
// constant to hardcode — the real expiry comes back as `expiresIn` (seconds)
// in POST /api/plex/pin/start's response and must be read from there, per
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
  | { status: "polling"; authUrl: string; expiresAt: number }
  | { status: "linked" }
  | { status: "expired" }
  | { status: "error"; message: string };

export type PinFlowEvent =
  | { type: "START" }
  | { type: "STARTED"; authUrl: string; expiresIn: number; now: number }
  | { type: "START_FAILED"; message: string }
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
      return { status: "polling", authUrl: event.authUrl, expiresAt: event.now + event.expiresIn * 1000 };
    case "START_FAILED":
      return { status: "error", message: event.message };
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
