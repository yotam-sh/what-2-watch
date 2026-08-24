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
import {
  getPlexServerOptions,
  setPlexServerSelection,
  type PlexServerOption,
  type PlexServersResponse,
} from "@/lib/client/plexServers";
import { useLinkStatus } from "@/lib/client/useLinkStatus";

function ServerBadge({ owned }: { owned: boolean }) {
  return owned ? (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      Yours
    </span>
  ) : (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
      Shared with you
    </span>
  );
}

function ReachabilityDot({ reachable }: { reachable: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${reachable ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400 dark:text-zinc-500"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${reachable ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"}`} />
      {reachable ? "Reachable" : "Unreachable"}
    </span>
  );
}

/** The server list itself: a single-server account renders an informational
 *  line (no controls — "don't make someone choose from a list of one"), a
 *  multi-server account renders checkboxes plus a Save step. Only fetched
 *  once Plex is confirmed linked. `onNeedsSelectionChange` lets the parent
 *  (PlexSection) disable "Sync now" while nothing is selected yet, instead
 *  of letting the user kick off a sync that's guaranteed to fail with
 *  PlexServerSelectionRequiredError. */
function PlexServerPicker({
  linked,
  onSelectionSaved,
  onNeedsSelectionChange,
}: {
  linked: boolean;
  onSelectionSaved: () => void;
  onNeedsSelectionChange: (needsSelection: boolean) => void;
}) {
  const [options, setOptions] = useState<PlexServersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    // Nothing to fetch until Plex is confirmed linked — `linked` itself
    // gates the render below (see the early return further down), so this
    // effect just does nothing rather than touching state synchronously
    // (react-hooks/set-state-in-effect); `loading` starts `true` by default
    // (see useLinkStatus.ts's own use of the same trick) and only ever
    // changes inside this .then() continuation, never synchronously here.
    if (!linked) return;
    let cancelled = false;
    getPlexServerOptions().then((result) => {
      if (cancelled || !mounted.current) return;
      setLoading(false);
      if (result.data) {
        setOptions(result.data);
        setPending(new Set(result.data.servers.filter((s) => s.selected).map((s) => s.machineIdentifier)));
        onNeedsSelectionChange(result.data.needsSelection);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onNeedsSelectionChange is a state setter (stable identity) from the parent; including it would just be noise.
  }, [linked]);

  function toggle(machineIdentifier: string) {
    setSaved(false);
    setError(null);
    setPending((prev) => {
      const next = new Set(prev);
      if (next.has(machineIdentifier)) {
        next.delete(machineIdentifier);
      } else {
        next.add(machineIdentifier);
      }
      return next;
    });
  }

  async function handleSave() {
    if (pending.size === 0) {
      setError("Select at least one server.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await setPlexServerSelection(Array.from(pending));
    setSaving(false);
    if (!mounted.current) return;
    if (!result.ok) {
      setError(result.error ?? "Could not save your selection.");
      return;
    }
    setSaved(true);
    onSelectionSaved();
    const refreshed = await getPlexServerOptions();
    if (mounted.current && refreshed.data) {
      setOptions(refreshed.data);
      setPending(new Set(refreshed.data.servers.filter((s) => s.selected).map((s) => s.machineIdentifier)));
      onNeedsSelectionChange(refreshed.data.needsSelection);
    }
  }

  if (!linked || loading || !options || options.servers.length === 0) {
    return null;
  }

  const { servers, needsSelection } = options;
  const currentlySelected = new Set(servers.filter((s) => s.selected).map((s) => s.machineIdentifier));
  const dirty =
    pending.size !== currentlySelected.size || Array.from(pending).some((id) => !currentlySelected.has(id));

  // Exactly one server: no picker, just make ownership legible — this is
  // the "don't make someone choose from a list of one" rule.
  if (servers.length === 1) {
    const only: PlexServerOption = servers[0];
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{only.name}</span>
          <ServerBadge owned={only.owned} />
          <ReachabilityDot reachable={only.reachable} />
        </div>
        {!only.owned && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            This server belongs to someone else&apos;s Plex account — your library, watch history, and
            recommendations will come from their media, not yours.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">
        Your Plex account can see more than one server. Choose which one(s) to draw media from.
      </p>
      {needsSelection && (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          Nothing is selected yet — pick at least one server before syncing.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {servers.map((s) => (
          <li key={s.machineIdentifier}>
            <label className="tap-target flex cursor-pointer items-center gap-2.5 rounded-md border border-zinc-200 px-3 py-2.5 text-sm dark:border-zinc-800">
              <input
                type="checkbox"
                checked={pending.has(s.machineIdentifier)}
                onChange={() => toggle(s.machineIdentifier)}
                className="h-4 w-4 shrink-0"
              />
              <span className="flex-1 truncate">{s.name}</span>
              <ServerBadge owned={s.owned} />
              <ReachabilityDot reachable={s.reachable} />
            </label>
            {!s.owned && pending.has(s.machineIdentifier) && (
              <p className="mt-1 pl-1 text-[11px] text-amber-700 dark:text-amber-400">
                Selecting this scans a library someone else owns.
              </p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="tap-target self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
        >
          {saving ? "Saving..." : "Save selection"}
        </button>
        {dirty && !saving && <span className="text-xs text-zinc-500">Unsaved changes</span>}
      </div>
      {saved && !dirty && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          Selection saved — sync now to apply it.
        </p>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function summarizeSync(job: PlexSyncJob): string {
  if (job.status === "failed") {
    return job.error ?? "Sync failed.";
  }
  const base =
    `Synced ${job.moviesSynced ?? 0} movies, ${job.showsSynced ?? 0} shows, ${job.watchlistSynced ?? 0} watchlist items. ` +
    `${job.libraryItemsSynced ?? 0} unwatched library items are now available to discover.`;
  if (job.serversUnreachable) {
    const plural = job.serversUnreachable === 1 ? "server" : "servers";
    return `${base} ${job.serversUnreachable} selected ${plural} couldn't be reached and ${job.serversUnreachable === 1 ? "was" : "were"} skipped this time.`;
  }
  return base;
}

function PlexSection() {
  const { plex, loading, refetch } = useLinkStatus();
  const [job, setJob] = useState<PlexSyncJob>(IDLE_SYNC_JOB);
  // Set from PlexServerPicker once it knows whether the account has 2+
  // servers with nothing selected yet — used to disable "Sync now" instead
  // of letting the user kick off a sync that's guaranteed to fail with
  // PlexServerSelectionRequiredError.
  const [needsServerSelection, setNeedsServerSelection] = useState(false);
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
          <PlexServerPicker
            linked={plex?.linked ?? false}
            onSelectionSaved={refetch}
            onNeedsSelectionChange={setNeedsServerSelection}
          />
          <button
            onClick={handleSync}
            disabled={syncing || needsServerSelection}
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
    <main className="min-h-screen-dvh pb-6 animate-content-in">
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
