// Instant Suspense fallback for /continue — see rewatch/loading.tsx for the
// full rationale (same pattern: this route's ContinuePage is a Server
// Component reading plexItems/titles straight from the DB during render).
// Header text is a byte-for-byte copy of ContinuePage's own (static, not
// data-derived), and the rows reuse SkeletonTitleRow so the real list swaps
// in with zero layout shift. This route keeps the row list — progress is
// the point here — while Rewatch/Watchlist are poster grids.
import { SkeletonTitleRow } from "@/components/SkeletonTitleRow";

const SKELETON_ROW_COUNT = 6;

export default function ContinueLoading() {
  return (
    <main className="min-h-screen-dvh pb-6">
      <header className="px-4 pt-6 pb-3">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Continue</h1>
        <p className="text-[13px] text-secondary">Pick up where you left off.</p>
      </header>

      <ul>
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <SkeletonTitleRow key={i} />
        ))}
      </ul>
    </main>
  );
}
