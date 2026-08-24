"use client";

// The entire signed-out experience: an Overseerr-style landing card with one
// button, "Sign in with Plex." No email field, no password field, no
// "create account" link — first sign-in *is* signup (see
// src/lib/plex/account.ts's find-or-create). Reuses the same pure PIN-flow
// state machine (src/lib/ui/pinFlow.ts) the old Settings-page linking UI
// used — the state machine itself never assumed who was calling it, so
// moving from "an already-signed-in user linking Plex" to "Plex login IS
// signing in" required no changes there, only new (unauthenticated) routes
// underneath it (/api/auth/plex/{start,poll}).
//
// The two Plex caveats — managed/Home users can't sign in, and every
// household member needs their own Plex account — are surfaced here rather
// than in Settings deliberately: this is the screen where they'd otherwise
// cause a confusing failed first run.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/client/http";
import {
  INITIAL_PIN_FLOW_STATE,
  isPolling,
  isTrustedPlexAuthCompleteMessage,
  MIN_POLL_INTERVAL_MS,
  pinFlowReducer,
  remainingMs,
} from "@/lib/ui/pinFlow";

// Name+size for the scripted popup — a fixed name means a second click
// reuses the same window (and re-navigates it) instead of spawning more
// popups.
const PLEX_AUTH_POPUP_NAME = "plex-auth";
const PLEX_AUTH_POPUP_FEATURES = "width=800,height=720";

// Comfortably above the 1s floor (constraint 10) — leaves headroom rather
// than polling at exactly the minimum.
const POLL_INTERVAL_MS = Math.max(MIN_POLL_INTERVAL_MS, 1500);

interface PinStartResponse {
  authUrl: string;
  expiresIn: number;
}
interface PinPollResponse {
  status?: "pending" | "linked";
  error?: string;
}

function formatMinutesSeconds(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function PlexSignInCard() {
  const router = useRouter();
  const [pinState, dispatchPin] = useReducer(pinFlowReducer, INITIAL_PIN_FLOW_STATE);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Same one-render-behind-is-fine rationale as the old SettingsScreen PIN
  // UI: poll() only reads this ref from inside an interval callback, well
  // after the commit that updated it.
  const pinStateRef = useRef(pinState);
  useEffect(() => {
    pinStateRef.current = pinState;
  }, [pinState]);

  // The popup window handle, so it can be navigated once the PIN resolves
  // and closed on unmount/failure. Not state — it's an imperative browser
  // handle, not something a render depends on.
  const popupRef = useRef<Window | null>(null);

  const poll = useCallback(async () => {
    const remaining = remainingMs(pinStateRef.current, Date.now());
    if (remaining !== null && remaining <= 0) {
      dispatchPin({ type: "TICK", now: Date.now() });
      return;
    }
    const result = await postJson<PinPollResponse>("/api/auth/plex/poll");
    if (!result.ok) {
      dispatchPin({ type: "POLL_ERROR", message: result.error ?? "Something went wrong while checking Plex." });
      return;
    }
    if (result.data?.status === "linked") {
      dispatchPin({ type: "POLL_LINKED" });
      router.push("/");
      router.refresh();
    } else {
      dispatchPin({ type: "POLL_PENDING" });
    }
  }, [router]);

  useEffect(() => {
    if (!isPolling(pinState)) return;
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pinState.status, poll]);

  // Purely-local 1s ticker for the displayed countdown — no network call.
  useEffect(() => {
    if (!isPolling(pinState)) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pinState.status]);

  // Listens for the plex-auth-callback popup's "I'm done" postMessage (see
  // src/app/plex-auth-callback/page.tsx) so the original tab doesn't have to
  // wait for the next poll tick. This is a *hint to poll sooner*, never
  // proof of anything: only a successful /api/auth/plex/poll response
  // (POLL_LINKED below) ever establishes a session. A forged or stale
  // message from the wrong origin is rejected outright, and even a
  // perfectly-shaped trusted one just triggers one extra, harmless poll —
  // it can't skip the poll itself. The regular interval below keeps running
  // regardless, covering the popup-blocked, closed-early, and
  // message-never-arrived cases.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isTrustedPlexAuthCompleteMessage(event, window.location.origin)) return;
      if (!isPolling(pinStateRef.current)) return;
      void poll();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [poll]);

  // Close any popup we opened if the component unmounts mid-flow (e.g. the
  // user navigates away) rather than leaving it dangling.
  useEffect(() => {
    return () => {
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    };
  }, []);

  async function handleStart() {
    dispatchPin({ type: "START" });

    // window.open() MUST run synchronously inside this click handler — if
    // it's awaited behind the /start fetch below, popup blockers treat it
    // as script-initiated (not user-initiated) and kill it. Opening it
    // blank first (rather than pre-fetching the PIN before the button is
    // even enabled) means no PIN — and no hit against the 5/min rate limit
    // on /api/auth/plex/start — is spent until the user actually clicks;
    // the URL is pushed into the already-open window once the PIN resolves
    // below.
    const popup = window.open("", PLEX_AUTH_POPUP_NAME, PLEX_AUTH_POPUP_FEATURES);
    popupRef.current = popup;

    const result = await postJson<PinStartResponse>("/api/auth/plex/start", {});
    if (!result.ok || !result.data) {
      dispatchPin({ type: "START_FAILED", message: result.error ?? "Could not start Plex sign-in." });
      popupRef.current?.close();
      popupRef.current = null;
      return;
    }

    const { authUrl, expiresIn } = result.data;
    dispatchPin({ type: "STARTED", authUrl, expiresIn, now: Date.now() });

    // `popup` may be null (blocked outright) or may have been closed by the
    // user while the /start fetch above was in flight — either way, fall
    // back to the plain link rather than throwing on a dead window handle.
    if (!popup || popup.closed) {
      dispatchPin({ type: "POPUP_BLOCKED" });
      return;
    }
    try {
      popup.location.href = authUrl;
    } catch {
      dispatchPin({ type: "POPUP_BLOCKED" });
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center shadow-2xl">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-50">what-to-watch</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Pulls your Plex + Letterboxd history and picks tonight&apos;s movie or show.
        </p>
      </div>

      <div className="flex w-full flex-col items-center gap-3">
        {(pinState.status === "idle" || pinState.status === "error" || pinState.status === "expired") && (
          <button
            onClick={handleStart}
            className="tap-target w-full rounded-md bg-brand px-6 py-3 text-base font-semibold text-brand-foreground"
          >
            Sign in with Plex
          </button>
        )}

        {pinState.status === "starting" && <p className="text-sm text-zinc-400">Starting...</p>}

        {isPolling(pinState) && (
          <div className="flex w-full flex-col gap-3 rounded-md border border-zinc-700 p-4">
            <p className="text-sm text-zinc-300">
              {pinState.popupBlocked
                ? "Your browser blocked the Plex sign-in popup. Use the link below instead — this page will pick it up automatically once you finish."
                : "A Plex sign-in window has opened. Log in and authorize this app there — this page will pick it up automatically."}
            </p>
            {pinState.popupBlocked && (
              <a
                href={pinState.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="tap-target rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground"
              >
                Open Plex to authorize
              </a>
            )}
            <p className="text-xs text-zinc-500">
              Waiting for you to finish... expires in {formatMinutesSeconds(remainingMs(pinState, nowTick) ?? 0)}
            </p>
          </div>
        )}

        {pinState.status === "linked" && (
          <p className="text-sm text-emerald-400">Signed in! Loading your account...</p>
        )}

        {pinState.status === "expired" && (
          <p className="text-sm text-zinc-400">
            That sign-in expired before you finished — no harm done, just try again.
          </p>
        )}

        {pinState.status === "error" && <p className="text-sm text-red-400">{pinState.message}</p>}
      </div>

      <ul className="w-full list-disc space-y-1.5 pl-5 text-left text-xs text-zinc-500">
        <li>
          Plex <strong className="text-zinc-400">managed/Home users cannot sign in</strong> — they have
          no plex.tv account of their own. If that&apos;s you, ask the account owner to create you a
          real Plex account instead.
        </li>
        <li>
          <strong className="text-zinc-400">Each household member signs in with their own Plex account</strong> —
          watch state is tied to your personal token, not the server.
        </li>
      </ul>
    </div>
  );
}
