// Layout-matched placeholder for TitleRow.tsx, used by /continue's
// loading.tsx skeleton. Every dimension here mirrors TitleRow exactly —
// same poster box (h-24 w-16, matching PosterImage's rendered size), same
// row padding/gap, same hairline divider, same <li> — so swapping the
// skeleton for the real row on data arrival causes zero layout shift.
// SkeletonTitleCard.tsx is the grid equivalent for Rewatch/Watchlist.
// The pulse is gated by motion-safe: so it's inert under
// prefers-reduced-motion while the blocks themselves (the actual loading
// information) still show.
import { Skeleton } from "@/components/ui/Skeleton";

export function SkeletonTitleRow() {
  return (
    <li className="flex gap-3 border-b border-line-soft px-4 py-2.5">
      <Skeleton className="h-24 w-16 shrink-0 rounded-[10px]" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-[3px] w-full rounded-full" />
      </div>
    </li>
  );
}
