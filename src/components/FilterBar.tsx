"use client";

import type { Dispatch } from "react";
import type { FilterAction, DecideFilters } from "@/lib/ui/filters";
import { QUICK_DECADES, QUICK_GENRES, QUICK_RUNTIMES } from "@/lib/ui/modes";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`tap-target shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-brand bg-brand/10 text-brand dark:bg-brand/20"
          : "border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
      }`}
    >
      {children}
    </button>
  );
}

export function FilterBar({ filters, dispatch }: { filters: DecideFilters; dispatch: Dispatch<FilterAction> }) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-2">
      <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
        {QUICK_RUNTIMES.map((option) => (
          <Chip
            key={option.label}
            active={filters.maxRuntimeMinutes === option.minutes}
            onClick={() => dispatch({ type: "SET_MAX_RUNTIME", minutes: option.minutes })}
          >
            {option.label}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
        {QUICK_DECADES.map((option) => (
          <Chip
            key={option.label}
            active={filters.decade === option.decade}
            onClick={() => dispatch({ type: "SET_DECADE", decade: option.decade })}
          >
            {option.label}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
        <Chip active={filters.genre === null} onClick={() => dispatch({ type: "SET_GENRE", genre: null })}>
          Any genre
        </Chip>
        {QUICK_GENRES.map((genre) => (
          <Chip
            key={genre}
            active={filters.genre === genre}
            onClick={() => dispatch({ type: "SET_GENRE", genre: filters.genre === genre ? null : genre })}
          >
            {genre}
          </Chip>
        ))}
      </div>
    </div>
  );
}
