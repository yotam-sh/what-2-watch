"use client";

// Settings — Letterboxd link/unlink/sync, Plex sync status, account
// deletion. Plex itself has nothing to link or unlink here any more: it's
// how the user signed in (see src/components/PlexSignInCard.tsx), so this
// screen only offers what's still meaningful post-login — triggering a
// sync and seeing whether a server connection has been confirmed.
//
// Plex sync is a background job now (see src/lib/plex/syncJob.ts and
// src/lib/client/plexSync.ts) — POST /api/plex/sync returns immediately, so
// this component polls GET /api/plex/sync/status for progress rather than
// awaiting one long request. On mount it checks status once, unprompted:
// a page reload mid-sync must not show an idle "Sync now" button while a
// job is actually still running server-side.
import { useEffect, useRef, useState } from "react";
import { DeleteAccountSection } from "@/components/DeleteAccountSection";
import { postJson } from "@/lib/client/http";
import { describeSyncPhase, getPlexSyncStatus, IDLE_SYNC_JOB, runPlexSync, type PlexSyncJob } from "@/lib/client/plexSync";
import { useLinkStatus } from "@/lib/client/useLinkStatus";

function summarizeSync(job: PlexSyncJob): string {
  if (job.status === "failed") {
    return job.error ?? "Sync failed.";
  }
  return (
    `Synced ${job.moviesSynced ?? 0} movies, ${job.showsSynced ?? 0} shows, ${job.watchlistSynced ?? 0} watchlist items. ` +
    `${job.libraryItemsSynced ?? 0} unwatched library items are now available to discover.`
  );
}

function PlexSection() {
  const { plex, loading, refetch } = useLinkStatus();
  const [job, setJob] = useState<PlexSyncJob>(IDLE_SYNC_JOB);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    // Survive a page reload mid-sync: ask the server whether a job is
    // already in flight for this user before rendering an idle button.
    getPlexSyncStatus().then((result) => {
      if (!mounted.current || !result.data) return;
      setJob(result.data);
      if (result.data.status === "running") {
        void runPlexSync((update) => {
          if (mounted.current) setJob(update);
        });
      }
    });
  }, []);

  async function handleSync() {
    setJob((prev) => ({ ...IDLE_SYNC_JOB, status: "running", phase: prev.phase ?? "scanning-library" }));
    const finalJob = await runPlexSync((update) => {
      if (mounted.current) setJob(update);
    });
    if (mounted.current) setJob(finalJob);
    refetch();
  }

  const syncing = job.status === "running";

  return (
    <section className="border-t border-zinc-200 px-4 py-6 dark:border-zinc-800">
      <h2 className="mb-1 text-base font-semibold">Plex</h2>

      {loading ? (
        <p className="text-sm text-zinc-500">Checking...</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-zinc-500">
            {plex && plex.linked && plex.hasConnection
              ? "A working connection to your server has been found."
              : "No server connection has been confirmed yet — try syncing."}
          </p>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="tap-target self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            {syncing ? "Syncing..." : "Sync now"}
          </button>
          {syncing && <p className="text-xs text-zinc-500">{describeSyncPhase(job)}</p>}
          {(job.status === "completed" || job.status === "failed") && (
            <p className={`text-xs ${job.status === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
              {summarizeSync(job)}
            </p>
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
    <main className="min-h-screen pb-6 animate-content-in">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500">Signed in as {username}</p>
      </header>

      <PlexSection />
      <LetterboxdSection />
      <DeleteAccountSection username={username} />
    </main>
  );
}
