"use client";

// Settings / Links — Plex PIN flow, Letterboxd link/unlink, manual sync
// triggers, account deletion. This is the app's first-run screen in
// practice (a brand-new account has nothing to roll until something is
// linked here), and the Plex PIN flow specifically is called out in the
// phase brief as needing real care: clear progress, honest expiry (read
// from the server's `expiresIn`, never assumed), and two facts stated
// BEFORE the user tries and fails — managed/Home Plex users have no
// plex.tv account to authenticate with, and every household member needs
// their own link because watch state is per-token.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { DeleteAccountSection } from "@/components/DeleteAccountSection";
import { postJson } from "@/lib/client/http";
import { useLinkStatus } from "@/lib/client/useLinkStatus";
import {
  INITIAL_PIN_FLOW_STATE,
  isPolling,
  MIN_POLL_INTERVAL_MS,
  pinFlowReducer,
  remainingMs,
} from "@/lib/ui/pinFlow";

// Comfortably above the 1s floor (constraint 10: "poll PINs at >= 1s") —
// leaves headroom rather than polling at exactly the minimum.
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

function PlexSection() {
  const { plex, loading, refetch } = useLinkStatus();
  const [pinState, dispatchPin] = useReducer(pinFlowReducer, INITIAL_PIN_FLOW_STATE);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [unlinking, setUnlinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  // Updated in an effect, not during render — mutating a ref's `.current`
  // directly in the render body is its own lint-flagged anti-pattern (can
  // read stale/inconsistent values under concurrent rendering). `poll()`
  // below only ever reads this ref from inside an interval callback, well
  // after the commit that updated it, so the effect's one-render-behind
  // timing is not a real race here.
  const pinStateRef = useRef(pinState);
  useEffect(() => {
    pinStateRef.current = pinState;
  }, [pinState]);

  const poll = useCallback(async () => {
    const remaining = remainingMs(pinStateRef.current, Date.now());
    if (remaining !== null && remaining <= 0) {
      dispatchPin({ type: "TICK", now: Date.now() });
      return;
    }
    const result = await postJson<PinPollResponse>("/api/plex/pin/poll");
    if (!result.ok) {
      dispatchPin({ type: "POLL_ERROR", message: result.error ?? "Something went wrong while checking Plex." });
      return;
    }
    if (result.data?.status === "linked") {
      dispatchPin({ type: "POLL_LINKED" });
      await refetch();
    } else {
      dispatchPin({ type: "POLL_PENDING" });
    }
  }, [refetch]);

  // The actual network-polling loop — fires no faster than POLL_INTERVAL_MS
  // (constraint 10) and only while genuinely waiting on a PIN.
  useEffect(() => {
    if (!isPolling(pinState)) return;
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pinState.status, poll]);

  // Separate, purely-local 1s ticker just to refresh the displayed
  // countdown text — no network call, so it doesn't touch constraint 10.
  useEffect(() => {
    if (!isPolling(pinState)) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pinState.status]);

  // Auto-clear the transient "linked!" success state once the authoritative
  // link status (from useLinkStatus) has refetched.
  useEffect(() => {
    if (pinState.status !== "linked") return;
    const t = setTimeout(() => dispatchPin({ type: "RESET" }), 2500);
    return () => clearTimeout(t);
  }, [pinState.status]);

  async function handleStart() {
    dispatchPin({ type: "START" });
    const result = await postJson<PinStartResponse>("/api/plex/pin/start", {});
    if (!result.ok || !result.data) {
      dispatchPin({ type: "START_FAILED", message: result.error ?? "Could not start the Plex link flow." });
      return;
    }
    dispatchPin({ type: "STARTED", authUrl: result.data.authUrl, expiresIn: result.data.expiresIn, now: Date.now() });
  }

  async function handleUnlink() {
    setUnlinking(true);
    await postJson("/api/plex/unlink");
    setUnlinking(false);
    dispatchPin({ type: "RESET" });
    refetch();
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    const result = await postJson<{ moviesSynced: number; showsSynced: number; watchlistSynced: number }>(
      "/api/plex/sync",
    );
    setSyncing(false);
    if (!result.ok) {
      setSyncMessage(result.error ?? "Sync failed.");
      return;
    }
    setSyncMessage(
      `Synced ${result.data?.moviesSynced ?? 0} movies, ${result.data?.showsSynced ?? 0} shows, ${result.data?.watchlistSynced ?? 0} watchlist items.`,
    );
    refetch();
  }

  const linked = plex?.linked ?? false;

  return (
    <section className="border-t border-zinc-200 px-4 py-6 dark:border-zinc-800">
      <h2 className="mb-1 text-base font-semibold">Plex</h2>

      {loading ? (
        <p className="text-sm text-zinc-500">Checking...</p>
      ) : linked ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Linked</p>
          <p className="text-xs text-zinc-500">
            {plex && plex.linked && plex.hasConnection
              ? "A working connection to your server has been found."
              : "No server connection has been confirmed yet — try syncing."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="tap-target rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
            <button
              onClick={handleUnlink}
              disabled={unlinking}
              className="tap-target rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
            >
              {unlinking ? "Unlinking..." : "Unlink"}
            </button>
          </div>
          {syncMessage && <p className="text-xs text-zinc-500">{syncMessage}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-500">
            <li>
              Plex <strong>managed/Home users cannot use this app</strong> — they have no plex.tv
              account of their own to authenticate with. If that&apos;s you, ask the account owner
              to create you a real Plex account instead.
            </li>
            <li>
              <strong>Each household member must link their own Plex account</strong> — watch state
              is tied to your personal token, not the server.
            </li>
          </ul>

          {pinState.status === "idle" && (
            <button
              onClick={handleStart}
              className="tap-target self-start rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
            >
              Link Plex
            </button>
          )}

          {pinState.status === "starting" && <p className="text-sm text-zinc-500">Starting...</p>}

          {isPolling(pinState) && (
            <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
              <p className="text-sm">
                Open Plex, log in, and authorize this app. This screen will pick it up
                automatically.
              </p>
              <a
                href={pinState.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="tap-target self-start rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
              >
                Open Plex to authorize
              </a>
              <p className="text-xs text-zinc-500">
                Waiting for you to finish... expires in {formatMinutesSeconds(remainingMs(pinState, nowTick) ?? 0)}
              </p>
            </div>
          )}

          {pinState.status === "linked" && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">Linked! Loading your account...</p>
          )}

          {pinState.status === "expired" && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-zinc-500">
                That PIN expired before you finished authorizing. No harm done — just start again.
              </p>
              <button
                onClick={handleStart}
                className="tap-target self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
              >
                Try again
              </button>
            </div>
          )}

          {pinState.status === "error" && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-red-600 dark:text-red-400">{pinState.message}</p>
              <button
                onClick={handleStart}
                className="tap-target self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function LetterboxdSection() {
  const { letterboxd, loading, refetch } = useLinkStatus();
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  async function handleLink(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await postJson<{ username: string; newEntries: number }>("/api/letterboxd/link", { username });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error ?? "Could not link that account.");
      return;
    }
    setUsername("");
    refetch();
  }

  async function handleUnlink() {
    setUnlinking(true);
    await postJson("/api/letterboxd/unlink");
    setUnlinking(false);
    refetch();
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    const result = await postJson<{ newEntries: number }>("/api/letterboxd/sync");
    setSyncing(false);
    if (!result.ok) {
      setSyncMessage(result.error ?? "Sync failed.");
      return;
    }
    setSyncMessage(`Synced — ${result.data?.newEntries ?? 0} new diary entries.`);
    refetch();
  }

  const linked = letterboxd?.linked ?? false;

  return (
    <section className="border-t border-zinc-200 px-4 py-6 dark:border-zinc-800">
      <h2 className="mb-1 text-base font-semibold">Letterboxd</h2>

      {loading ? (
        <p className="text-sm text-zinc-500">Checking...</p>
      ) : linked && letterboxd?.linked ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Linked as {letterboxd.username}</p>
          {letterboxd.lastError && (
            <p className="text-xs text-red-600 dark:text-red-400">Last sync error: {letterboxd.lastError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="tap-target rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
            <button
              onClick={handleUnlink}
              disabled={unlinking}
              className="tap-target rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
            >
              {unlinking ? "Unlinking..." : "Unlink"}
            </button>
          </div>
          {syncMessage && <p className="text-xs text-zinc-500">{syncMessage}</p>}
        </div>
      ) : (
        <form onSubmit={handleLink} className="flex flex-col gap-2">
          <p className="text-xs text-zinc-500">
            Reads your public diary via RSS — no password needed, just your username.
          </p>
          <div className="flex max-w-xs gap-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="letterboxd username"
              required
              className="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-base outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="submit"
              disabled={submitting}
              className="tap-target rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground disabled:opacity-50"
            >
              {submitting ? "Linking..." : "Link"}
            </button>
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </form>
      )}
    </section>
  );
}

export function SettingsScreen({ username }: { username: string }) {
  return (
    <main className="min-h-screen pb-6">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500">Signed in as {username}</p>
      </header>

      <PlexSection />
      <LetterboxdSection />
      <DeleteAccountSection />
    </main>
  );
}
