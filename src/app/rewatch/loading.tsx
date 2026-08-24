// Instant Suspense fallback for /rewatch. Next.js renders this the moment
// navigation starts (via BottomNav's <Link>, which prefetches it on
// viewport entry), so the tap feels acknowledged immediately instead of
// leaving the previous page on screen until RewatchPage's DB reads
// (getReconciledWatchHistory() + the plexItems/titles queries in
// loadRewatchList()) resolve.
//
// The header below is a byte-for-byte copy of RewatchPage's — it's static
// text, not data-derived, so there's nothing to skeletonize there and no
// flash when the real header mounts in its place. The rows use
// SkeletonTitleRow, which mirrors TitleRow's exact box sizes, so the real
// list swaps in with zero layout shift.
import { SkeletonTitleRow } from "@/components/SkeletonTitleRow";

const SKELETON_ROW_COUNT = 6;

export default function RewatchLoading() {
  return (
    <main className="min-h-screen pb-6">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold">Rewatch</h1>
        <p className="text-sm text-zinc-500">Sorted by how long it&apos;s been since you last watched.</p>
      </header>

      <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <SkeletonTitleRow key={i} />
        ))}
      </ul>
    </main>
  );
}
