// Generic placeholder block shared by the loading.tsx skeletons. Sizing is
// left entirely to the caller's className so each skeleton can match its
// real counterpart's rendered dimensions exactly — that's what keeps layout
// shift at zero when the real content swaps in.
//
// The pulse is gated by motion-safe: so it's inert under
// prefers-reduced-motion while the block itself (the loading information)
// still shows.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`rounded-[6px] bg-elevated motion-safe:animate-pulse ${className}`} />;
}
