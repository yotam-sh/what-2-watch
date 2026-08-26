"use client";

// Generic "sync now" trigger used by the Rewatch/Watchlist/Continue Server
// Component pages (empty states) and by SettingsScreen. Posts to whichever
// sync endpoint(s) it's given, then router.refresh() so the Server
// Component re-queries the DB with fresh data — simpler than duplicating
// each page's query as client-side fetch logic just for this one button.
//
// /api/plex/sync is special-cased: it's a background job now (see
// src/lib/plex/syncJob.ts and src/lib/client/plexSync.ts's file headers —
// the 502-after-5,680ms incident this fixes), so it needs to be started and
// then polled to completion rather than just POSTed and awaited once. Every
// other endpoint (e.g. /api/letterboxd/sync) is still a plain synchronous
// POST.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { postJson } from "@/lib/client/http";
import { describeSyncPhase, getPlexSyncStatus, pollPlexSyncUntilSettled, runPlexSync } from "@/lib/client/plexSync";

const PLEX_SYNC_ENDPOINT = "/api/plex/sync";

export function SyncButton({ endpoints, label = "Sync now" }: { endpoints: string[]; label?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    // Survive a page reload mid-sync: a Plex job started from elsewhere
    // (or before this component remounted) must not leave this button
    // looking idle while the server is still working.
    if (!endpoints.includes(PLEX_SYNC_ENDPOINT)) return;
    getPlexSyncStatus().then((result) => {
      if (!mounted.current || result.data?.status !== "running") return;
      setLoading(true);
      setProgress(describeSyncPhase(result.data));
      void pollPlexSyncUntilSettled((update) => {
        if (!mounted.current) return;
        if (update.status === "running") setProgress(describeSyncPhase(update));
      }).then((finalJob) => {
        if (!mounted.current) return;
        setProgress(null);
        setError(finalJob.status === "failed" ? (finalJob.error ?? "Sync failed.") : null);
        setLoading(false);
        router.refresh();
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- endpoints/router are stable for this button's lifetime; re-running on every render would re-poll
  }, []);

  async function runEndpoint(endpoint: string): Promise<string | null> {
    if (endpoint === PLEX_SYNC_ENDPOINT) {
      const job = await runPlexSync((update) => {
        if (update.status === "running") setProgress(describeSyncPhase(update));
      });
      return job.status === "failed" ? (job.error ?? "Sync failed.") : null;
    }
    const result = await postJson(endpoint);
    return result.ok ? null : (result.error ?? "Sync failed.");
  }

  async function handleClick() {
    setLoading(true);
    setProgress(null);
    setError(null);
    const errors = await Promise.all(endpoints.map(runEndpoint));
    setProgress(null);
    setError(errors.find((e) => e !== null) ?? null);
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button onClick={handleClick} disabled={loading} variant="secondary">
        {loading ? "Syncing..." : label}
      </Button>
      {loading && progress && <p className="max-w-xs text-center text-xs text-secondary">{progress}</p>}
      {error && <p className="max-w-xs text-center text-[13px] text-negative">{error}</p>}
    </div>
  );
}
