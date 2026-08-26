"use client";

// Trigger for the filter bottom sheet (FilterSheet.tsx). Replaces the old
// always-visible chip row (formerly FilterBar.tsx) — a filtered-down Decide
// screen should look obviously filtered, hence the count badge: without it,
// a 90-minute runtime cap set two rolls ago and forgotten about looks
// identical to no filter at all, which reads as "the recommender is broken"
// rather than "I filtered this."
//
// Icon-only, and it shares a row with ModeSelector. The "Filters" label was
// dropped so the two fit across a phone without either wrapping or side
// scrolling; the funnel glyph is unambiguous and aria-label carries the name
// for anyone who can't see it. The count moved from an inline badge to a
// corner marker for the same reason — there is no inline left to sit on.
import type { Ref } from "react";
import { FilterIcon } from "./icons";

export function FilterButton({
  activeCount,
  onClick,
  ref,
}: {
  activeCount: number;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
      className="tap-target relative flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-line bg-card text-body transition-colors duration-[180ms] ease-out hover:border-[color:var(--accent-line)] hover:bg-hover"
    >
      <FilterIcon className={`h-5 w-5 ${activeCount > 0 ? "text-accent" : "text-muted"}`} strokeWidth={2} />
      {activeCount > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 font-mono text-[10px] font-semibold tabular-nums text-accent-contrast"
        >
          {activeCount}
        </span>
      )}
    </button>
  );
}
