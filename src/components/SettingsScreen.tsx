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
import { Bookmark, Check, Film, LoaderCircle, Tv } from "lucide-react";
import { DeleteAccountSection } from "@/components/DeleteAccountSection";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
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
  // Amber for a server you don't own: it's a caution, not a status. Whose
  // library you're drawing from changes what every recommendation means.
  return owned ? <Badge tone="neutral">Yours</Badge> : <Badge tone="warning">Shared with you</Badge>;
}

function ReachabilityDot({ reachable }: { reachable: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${reachable ? "text-positive" : "text-muted"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${reachable ? "bg-positive" : "bg-[color:var(--text-muted)]"}`} />
      {reachable ? "Reachable" : "Unreachable"}
    </span>
  );
}

/** Custom checkbox. The real <input> stays in the DOM (sr-only) so the label
 *  association, keyboard toggle, and screen-reader semantics are the
 *  browser's, not ours — only the box is drawn by hand. */
function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-[180ms] ease-out peer-focus-visible:shadow-[var(--ring)] ${
        checked ? "border-accent bg-accent" : "border-line-strong"
      }`}
    >
      {checked && <Check className="h-3 w-3 text-heading" strokeWidth={3} />}
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
      <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-inset px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-body">{only.name}</span>
          <ServerBadge owned={only.owned} />
          <ReachabilityDot reachable={only.reachable} />
        </div>
        {!only.owned && (
          <p className="text-xs text-warning">
            This server belongs to someone else&apos;s Plex account — your library, watch history, and
            recommendations will come from their media, not yours.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-secondary">
        Your Plex account can see more than one server. Choose which one(s) to draw media from.
      </p>
      {needsSelection && (
        <p className="text-[11px] font-medium text-warning">
          Nothing is selected yet — pick at least one server before syncing.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {servers.map((s) => (
          <li key={s.machineIdentifier}>
            <label className="tap-target flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-line bg-card px-3 py-2.5 text-[13px] text-body transition-colors duration-[180ms] ease-out hover:bg-hover">
              <input
                type="checkbox"
                checked={pending.has(s.machineIdentifier)}
                onChange={() => toggle(s.machineIdentifier)}
                className="peer sr-only"
              />
              <CheckboxBox checked={pending.has(s.machineIdentifier)} />
              <span className="flex-1 truncate">{s.name}</span>
              <ServerBadge owned={s.owned} />
              <ReachabilityDot reachable={s.reachable} />
            </label>
            {!s.owned && pending.has(s.machineIdentifier) && (
              <p className="mt-1 pl-1 text-[11px] text-warning">
                Selecting this scans a library someone else owns.
              </p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || !dirty} variant="secondary" className="self-start">
          {saving ? "Saving..." : "Save selection"}
        </Button>
        {dirty && !saving && <span className="text-[11px] text-warning">Unsaved changes</span>}
      </div>
      {saved && !dirty && <p className="text-xs text-positive">Selection saved — sync now to apply it.</p>}
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}

// Kept whole and unchanged. Only its failure branch is reached from this
// screen now — a completed job renders as StatCards plus SyncCaveats below,
// reading the same fields off the same job object.
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

/** The prose that doesn't fit in a StatCard: the discover-pool size, and the
 *  skipped-server caveat. Same fields, same wording as summarizeSync. */
function SyncCaveats({ job }: { job: PlexSyncJob }) {
  const plural = job.serversUnreachable === 1 ? "server" : "servers";
  return (
    <div className="flex flex-col gap-1 text-xs text-secondary">
      <p>
        <span className="font-mono tabular-nums">{job.libraryItemsSynced ?? 0}</span> unwatched library items
        are now available to discover.
      </p>
      {job.serversUnreachable ? (
        <p className="text-warning">
          <span className="font-mono tabular-nums">{job.serversUnreachable}</span> selected {plural}{" "}
          couldn&apos;t be reached and {job.serversUnreachable === 1 ? "was" : "were"} skipped this time.
        </p>
      ) : null}
    </div>
  );
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
    <Card header={<CardHeader title="Plex" sub="How you signed in — and where your media comes from." />}>
      {loading ? (
        <p className="text-[13px] text-secondary">Checking...</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-xs text-secondary">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                plex && plex.linked && plex.hasConnection ? "bg-positive" : "bg-[color:var(--text-muted)]"
              }`}
            />
            {plex && plex.linked && plex.hasConnection
              ? "A working connection to your server has been found."
              : "No server connection has been confirmed yet — try syncing."}
          </p>
          <PlexServerPicker
            linked={plex?.linked ?? false}
            onSelectionSaved={refetch}
            onNeedsSelectionChange={setNeedsServerSelection}
          />
          <Button
            onClick={handleSync}
            disabled={syncing || needsServerSelection}
            variant="primary"
            className="self-start"
          >
            {syncing ? "Syncing..." : "Sync now"}
          </Button>
          {syncing && (
            <p className="flex items-center gap-2 text-xs text-secondary">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
              {describeSyncPhase(job)}
            </p>
          )}
          {job.status === "failed" && <p className="text-xs text-negative">{summarizeSync(job)}</p>}
          {job.status === "completed" && (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <StatCard label="Movies" value={job.moviesSynced ?? 0} icon={<Film className="h-4 w-4" />} />
                <StatCard label="Shows" value={job.showsSynced ?? 0} icon={<Tv className="h-4 w-4" />} />
                <StatCard
                  label="Watchlist"
                  value={job.watchlistSynced ?? 0}
                  icon={<Bookmark className="h-4 w-4" />}
                />
              </div>
              <SyncCaveats job={job} />
            </div>
          )}
        </div>
      )}
    </Card>
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
    <Card header={<CardHeader title="Letterboxd" sub="Your diary and ratings, read from the public RSS feed." />}>
      {loading ? (
        <p className="text-[13px] text-secondary">Checking...</p>
      ) : linked && letterboxd?.linked ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-positive">Linked as {letterboxd.username}</p>
          {letterboxd.lastError && (
            <p className="text-xs text-negative">Last sync error: {letterboxd.lastError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSync} disabled={syncing} variant="secondary">
              {syncing ? "Syncing..." : "Sync now"}
            </Button>
            <Button onClick={handleUnlink} disabled={unlinking} variant="secondary">
              {unlinking ? "Unlinking..." : "Unlink"}
            </Button>
          </div>
          {syncMessage && <p className="text-xs text-secondary">{syncMessage}</p>}
        </div>
      ) : (
        <form onSubmit={handleLink} className="flex flex-col gap-2">
          <p className="text-xs text-secondary">
            Reads your public diary via RSS — no password needed, just your username.
          </p>
          <div className="flex max-w-xs gap-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="letterboxd username"
              required
              // text-base (16px) rather than the 13px this card otherwise
              // uses: iOS Safari zooms the whole page when a focused input's
              // font-size is under 16px, and that zoom doesn't undo itself.
              className="h-[38px] min-w-0 flex-1 rounded-[10px] border border-line bg-inset px-3 text-base text-body outline-none transition-colors duration-[180ms] ease-out placeholder:text-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
            <Button type="submit" disabled={submitting} variant="primary">
              {submitting ? "Linking..." : "Link"}
            </Button>
          </div>
          {error && <p className="text-[13px] text-negative">{error}</p>}
        </form>
      )}
    </Card>
  );
}

export function SettingsScreen({ username }: { username: string }) {
  return (
    <main className="min-h-screen-dvh pb-6 animate-content-in">
      <header className="px-4 pt-6 pb-3">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Settings</h1>
        <p className="text-[13px] text-secondary">Signed in as {username}</p>
      </header>

      <div className="flex flex-col gap-4 px-4">
        <PlexSection />
        <LetterboxdSection />
        <DeleteAccountSection username={username} />
      </div>
    </main>
  );
}
