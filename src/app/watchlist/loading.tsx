// Instant Suspense fallback for /watchlist — see rewatch/loading.tsx for
// the full rationale (same pattern: this route's WatchlistPage is a Server
// Component reading watchlistItems/titles straight from the DB during
// render). Header text is a byte-for-byte copy of WatchlistPage's own
// (static, not data-derived), and the cells reuse SkeletonTitleCard so the
// real grid swaps in with zero layout shift.
import { SkeletonTitleCard } from "@/components/SkeletonTitleCard";

const SKELETON_CELL_COUNT = 9;

export default function WatchlistLoading() {
  return (
    <main className="min-h-screen-dvh pb-6">
      <header className="px-4 pt-6 pb-3">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Watchlist</h1>
        <p className="text-[13px] text-secondary">From your Plex Discover watchlist.</p>
      </header>

      <ul className="grid grid-cols-3 gap-3 px-4 sm:grid-cols-4">
        {Array.from({ length: SKELETON_CELL_COUNT }, (_, i) => (
          <SkeletonTitleCard key={i} />
        ))}
      </ul>
    </main>
  );
}
