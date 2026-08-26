// Generic placeholder bar shared by the loading.tsx skeletons that need to
// stand in for real text/controls whose content isn't known until a
// Server Component's DB read resolves (username, sync status, etc.) —
// SkeletonTitleRow.tsx covers the browse-row case specifically; this covers
// everything else. Sizing is left entirely to the caller's className so
// each skeleton can match its real counterpart's rendered dimensions
// exactly. The pulse is gated by motion-safe: so it's inert under
// prefers-reduced-motion while the bar itself (the loading information)
// still shows.
//
// Thin wrapper over ui/Skeleton so the many existing call sites keep working
// with their current import; new code should reach for Skeleton directly.
import { Skeleton } from "@/components/ui/Skeleton";

export function SkeletonBar({ className }: { className: string }) {
  return <Skeleton className={className} />;
}
