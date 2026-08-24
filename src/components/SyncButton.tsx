"use client";

// Generic "sync now" trigger used by the Rewatch/Watchlist/Continue Server
// Component pages (empty states) and by SettingsScreen. Posts to whichever
// sync endpoint(s) it's given, then router.refresh() so the Server
// Component re-queries the DB with fresh data — simpler than duplicating
// each page's query as client-side fetch logic just for this one button.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client/http";

export function SyncButton({ endpoints, label = "Sync now" }: { endpoints: string[]; label?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const results = await Promise.all(endpoints.map((endpoint) => postJson(endpoint)));
    const failed = results.find((r) => !r.ok);
    setError(failed ? (failed.error ?? "Sync failed.") : null);
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className="tap-target rounded-md border border-zinc-300 px-5 py-2.5 font-medium disabled:opacity-50 dark:border-zinc-700"
      >
        {loading ? "Syncing..." : label}
      </button>
      {error && <p className="max-w-xs text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
