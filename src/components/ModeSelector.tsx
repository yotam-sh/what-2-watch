"use client";

import { DECIDE_MODES, type DecideMode } from "@/lib/ui/modes";

export function ModeSelector({ mode, onChange }: { mode: DecideMode; onChange: (mode: DecideMode) => void }) {
  return (
    <div role="tablist" aria-label="Roll mode" className="flex gap-2 overflow-x-auto px-4 pb-1 pt-3 -mx-1">
      {DECIDE_MODES.map((option) => {
        const active = option.value === mode;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`tap-target shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-brand text-brand-foreground"
                : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
