// Instant Suspense fallback for /rewatch. Next.js renders this the moment
// navigation starts (via BottomNav's <Link>, which prefetches it on
// viewport entry), so the tap feels acknowledged immediately instead of
// leaving the previous page on screen until RewatchPage's DB reads
// (getReconciledWatchHistory() + the plexItems/titles queries in
// loadRewatchList()) resolve.
//
// The header below is a byte-for-byte copy of RewatchPage's — it's static
// text, not data-derived, so there's nothing to skeletonize there and no
// flash when the real header mounts in its place. The cells use
// SkeletonTitleCard, which mirrors TitleCard's exact box sizes, so the real
// grid swaps in with zero layout shift.
import { SkeletonTitleCard } from "@/components/SkeletonTitleCard";

const SKELETON_CELL_COUNT = 9;

export default function RewatchLoading() {
  return (
    <main className="min-h-screen-dvh pb-6">
      <header className="px-4 pt-6 pb-3">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Rewatch</h1>
        <p className="text-[13px] text-secondary">Sorted by how long it&apos;s been since you last watched.</p>
      </header>

      <ul className="grid grid-cols-3 gap-3 px-4 sm:grid-cols-4">
        {Array.from({ length: SKELETON_CELL_COUNT }, (_, i) => (
          <SkeletonTitleCard key={i} />
        ))}
      </ul>
    </main>
  );
}
