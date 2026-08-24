// Layout-matched placeholder for TitleRow.tsx, used by the browse screens'
// loading.tsx skeletons (rewatch/watchlist/continue). Every dimension here
// mirrors TitleRow exactly — same poster box (h-24 w-16, matching
// PosterImage's rendered size), same row padding/gap, same <li> — so
// swapping the skeleton for the real row on data arrival causes zero
// layout shift. The pulse is gated by motion-safe: so it's inert under
// prefers-reduced-motion while the gray blocks themselves (the actual
// loading information) still show.
export function SkeletonTitleRow() {
  return (
    <li className="flex gap-3 px-4 py-2.5">
      <div className="h-24 w-16 shrink-0 overflow-hidden rounded-md bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <div className="h-4 w-3/4 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />
        <div className="h-3 w-1/2 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />
      </div>
    </li>
  );
}
