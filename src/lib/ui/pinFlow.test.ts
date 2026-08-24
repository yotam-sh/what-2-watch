import { describe, expect, it } from "vitest";
import {
  INITIAL_PIN_FLOW_STATE,
  isPolling,
  isTrustedPlexAuthCompleteMessage,
  MIN_POLL_INTERVAL_MS,
  PLEX_AUTH_COMPLETE_MESSAGE_TYPE,
  pinFlowReducer,
  remainingMs,
  type PinFlowState,
} from "./pinFlow";

describe("MIN_POLL_INTERVAL_MS", () => {
  it("never polls plex.tv faster than 1s (constraint 10)", () => {
    expect(MIN_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe("pinFlowReducer", () => {
  it("starts idle", () => {
    expect(INITIAL_PIN_FLOW_STATE).toEqual({ status: "idle" });
  });

  it("START moves to starting", () => {
    const next = pinFlowReducer(INITIAL_PIN_FLOW_STATE, { type: "START" });
    expect(next).toEqual({ status: "starting" });
  });

  it("STARTED computes expiresAt from the server's real expiresIn, not a hardcoded guess", () => {
    const now = 1_000_000;
    const next = pinFlowReducer(
      { status: "starting" },
      { type: "STARTED", authUrl: "https://app.plex.tv/auth#?...", expiresIn: 1800, now },
    );
    expect(next).toEqual({
      status: "polling",
      authUrl: "https://app.plex.tv/auth#?...",
      expiresAt: now + 1800 * 1000,
      popupBlocked: false,
    });
  });

  it("a short server-reported expiresIn produces a short expiry window, not a fixed 30 minutes", () => {
    const now = 0;
    const next = pinFlowReducer(
      { status: "starting" },
      { type: "STARTED", authUrl: "https://app.plex.tv/auth", expiresIn: 60, now },
    );
    expect(isPolling(next) && next.expiresAt).toBe(60_000);
  });

  it("START_FAILED surfaces the error message", () => {
    const next = pinFlowReducer({ status: "starting" }, { type: "START_FAILED", message: "network error" });
    expect(next).toEqual({ status: "error", message: "network error" });
  });

  it("POLL_PENDING is a no-op while polling", () => {
    const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 5000, popupBlocked: false };
    expect(pinFlowReducer(polling, { type: "POLL_PENDING" })).toBe(polling);
  });

  it("POLL_LINKED moves to linked", () => {
    const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 5000, popupBlocked: false };
    expect(pinFlowReducer(polling, { type: "POLL_LINKED" })).toEqual({ status: "linked" });
  });

  it("POLL_ERROR (e.g. session expired mid-poll) moves to error with the message", () => {
    const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 5000, popupBlocked: false };
    const next = pinFlowReducer(polling, {
      type: "POLL_ERROR",
      message: "Your session expired. Please log in again, then retry linking Plex.",
    });
    expect(next).toEqual({
      status: "error",
      message: "Your session expired. Please log in again, then retry linking Plex.",
    });
  });

  describe("expiry via TICK", () => {
    it("expires once now reaches expiresAt", () => {
      const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 1000, popupBlocked: false };
      const next = pinFlowReducer(polling, { type: "TICK", now: 1000 });
      expect(next).toEqual({ status: "expired" });
    });

    it("expires once now passes expiresAt", () => {
      const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 1000, popupBlocked: false };
      const next = pinFlowReducer(polling, { type: "TICK", now: 1500 });
      expect(next).toEqual({ status: "expired" });
    });

    it("does not expire before expiresAt", () => {
      const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 1000, popupBlocked: false };
      const next = pinFlowReducer(polling, { type: "TICK", now: 999 });
      expect(next).toBe(polling);
    });

    it("TICK is a no-op outside the polling state", () => {
      expect(pinFlowReducer({ status: "idle" }, { type: "TICK", now: 999_999_999 })).toEqual({ status: "idle" });
      expect(pinFlowReducer({ status: "linked" }, { type: "TICK", now: 999_999_999 })).toEqual({ status: "linked" });
    });
  });

  it("RESET returns to idle from any state", () => {
    expect(pinFlowReducer({ status: "expired" }, { type: "RESET" })).toEqual({ status: "idle" });
    expect(pinFlowReducer({ status: "linked" }, { type: "RESET" })).toEqual({ status: "idle" });
    expect(pinFlowReducer({ status: "error", message: "x" }, { type: "RESET" })).toEqual({ status: "idle" });
  });

  describe("POPUP_BLOCKED (window.open() blocked or closed before it could be navigated)", () => {
    it("flips popupBlocked while polling, leaving the rest of the state untouched", () => {
      const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 5000, popupBlocked: false };
      const next = pinFlowReducer(polling, { type: "POPUP_BLOCKED" });
      expect(next).toEqual({ status: "polling", authUrl: "u", expiresAt: 5000, popupBlocked: true });
    });

    it("does not resurrect polling once already expired/linked/idle — it's a no-op outside polling", () => {
      expect(pinFlowReducer({ status: "idle" }, { type: "POPUP_BLOCKED" })).toEqual({ status: "idle" });
      expect(pinFlowReducer({ status: "expired" }, { type: "POPUP_BLOCKED" })).toEqual({ status: "expired" });
      expect(pinFlowReducer({ status: "linked" }, { type: "POPUP_BLOCKED" })).toEqual({ status: "linked" });
    });
  });
});

describe("isPolling", () => {
  it("narrows correctly", () => {
    expect(isPolling({ status: "polling", authUrl: "u", expiresAt: 1, popupBlocked: false })).toBe(true);
    expect(isPolling({ status: "idle" })).toBe(false);
    expect(isPolling({ status: "linked" })).toBe(false);
  });
});

describe("remainingMs", () => {
  it("is null outside the polling state", () => {
    expect(remainingMs({ status: "idle" }, 0)).toBeNull();
    expect(remainingMs({ status: "linked" }, 0)).toBeNull();
  });

  it("counts down while polling", () => {
    const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 10_000, popupBlocked: false };
    expect(remainingMs(polling, 4_000)).toBe(6_000);
  });

  it("clamps at 0 rather than going negative", () => {
    const polling: PinFlowState = { status: "polling", authUrl: "u", expiresAt: 10_000, popupBlocked: false };
    expect(remainingMs(polling, 50_000)).toBe(0);
  });
});

describe("isTrustedPlexAuthCompleteMessage", () => {
  const ORIGIN = "https://app.example.com";

  it("trusts a same-origin message with the expected payload shape", () => {
    expect(
      isTrustedPlexAuthCompleteMessage(
        { origin: ORIGIN, data: { type: PLEX_AUTH_COMPLETE_MESSAGE_TYPE } },
        ORIGIN,
      ),
    ).toBe(true);
  });

  it("rejects a message from a foreign origin, even with a perfectly-shaped payload", () => {
    expect(
      isTrustedPlexAuthCompleteMessage(
        { origin: "https://evil.example.com", data: { type: PLEX_AUTH_COMPLETE_MESSAGE_TYPE } },
        ORIGIN,
      ),
    ).toBe(false);
  });

  it("rejects a same-origin message with the wrong payload type", () => {
    expect(
      isTrustedPlexAuthCompleteMessage({ origin: ORIGIN, data: { type: "something-else" } }, ORIGIN),
    ).toBe(false);
  });

  it("rejects malformed payloads (null, non-object, missing type) without throwing", () => {
    expect(isTrustedPlexAuthCompleteMessage({ origin: ORIGIN, data: null }, ORIGIN)).toBe(false);
    expect(isTrustedPlexAuthCompleteMessage({ origin: ORIGIN, data: "plex-auth-complete" }, ORIGIN)).toBe(
      false,
    );
    expect(isTrustedPlexAuthCompleteMessage({ origin: ORIGIN, data: {} }, ORIGIN)).toBe(false);
  });
});
