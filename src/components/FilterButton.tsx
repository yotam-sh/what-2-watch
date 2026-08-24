"use client";

// Trigger for the filter bottom sheet (FilterSheet.tsx). Replaces the old
// always-visible chip row (formerly FilterBar.tsx) — a filtered-down Decide
// screen should look obviously filtered, hence the count badge: without it,
// a 90-minute runtime cap set two rolls ago and forgotten about looks
// identical to no filter at all, which reads as "the recommender is broken"
// rather than "I filtered this."
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
    <div className="px-4 pb-2">
      <button
        ref={ref}
        onClick={onClick}
        aria-haspopup="dialog"
        aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
        className="tap-target inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-3.5 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
      >
        <FilterIcon className="h-4 w-4" />
        Filters
        {activeCount > 0 && (
          <span
            aria-hidden="true"
            className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-xs font-semibold text-brand-foreground"
          >
            {activeCount}
          </span>
        )}
      </button>
    </div>
  );
}
