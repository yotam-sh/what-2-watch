// Instant Suspense fallback for /watchlist — see rewatch/loading.tsx for
// the full rationale (same pattern: this route's WatchlistPage is a Server
// Component reading watchlistItems/titles straight from the DB during
// render). Header text is a byte-for-byte copy of WatchlistPage's own
// (static, not data-derived), and the rows reuse SkeletonTitleRow so the
// real list swaps in with zero layout shift.
import { SkeletonTitleRow } from "@/components/SkeletonTitleRow";

const SKELETON_ROW_COUNT = 6;

export default function WatchlistLoading() {
  return (
    <main className="min-h-screen pb-6">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold">Watchlist</h1>
        <p className="text-sm text-zinc-500">From your Plex Discover watchlist.</p>
      </header>

      <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <SkeletonTitleRow key={i} />
        ))}
      </ul>
    </main>
  );
}
