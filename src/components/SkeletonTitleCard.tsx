// Grid equivalent of SkeletonTitleRow — the Rewatch/Watchlist loading
// fallback. Mirrors TitleCard.tsx's boxes exactly (2:3 poster at radius 10,
// a two-line title block, a meta line) so the real grid swaps in with zero
// layout shift.
import { Skeleton } from "@/components/ui/Skeleton";

export function SkeletonTitleCard() {
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <Skeleton className="aspect-[2/3] w-full rounded-[10px]" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-[11px] w-2/3" />
    </li>
  );
}
