"use client";

// Two presentations of the same choice, picked by viewport width.
//
// Phone (< sm): a native <select> pill. It used to be a horizontally
// scrolling pill row, which was wrong twice over — the Decide screen is a
// swipe surface, so a sideways-scrolling strip sitting above the poster
// competes with the gesture that actually matters, and five labels
// ("Discover" … "Watchlist") simply do not fit across 390px next to the
// filter button they now share a row with. A native select opens the OS
// picker, costs one line of vertical space, never scrolls, and gets
// keyboard/AT behaviour from the platform for free.
//
// Desktop (>= sm): the pill row, unchanged in spirit — there is room for it
// there, and one-tap switching beats a dropdown when the space exists. It
// wraps rather than scrolls if it ever runs out of room.
import { ChevronDown } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { DECIDE_MODES, type DecideMode } from "@/lib/ui/modes";

export function ModeSelector({ mode, onChange }: { mode: DecideMode; onChange: (mode: DecideMode) => void }) {
  return (
    <>
      {/* Phone */}
      <div className="relative min-w-0 flex-1 sm:hidden">
        <select
          aria-label="Roll mode"
          value={mode}
          onChange={(e) => onChange(e.target.value as DecideMode)}
          // text-base (16px) so iOS Safari doesn't zoom the page when the
          // picker opens — the same rule the text inputs follow.
          className="tap-target w-full appearance-none rounded-full border border-line bg-card py-2 pl-4 pr-9 text-base font-medium text-body outline-none transition-colors duration-[180ms] ease-out hover:bg-hover"
        >
          {DECIDE_MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={2}
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        />
      </div>

      {/* Desktop */}
      <div role="tablist" aria-label="Roll mode" className="hidden min-w-0 flex-1 flex-wrap gap-2 sm:flex">
        {DECIDE_MODES.map((option) => {
          const active = option.value === mode;
          return (
            <Pill
              key={option.value}
              role="tab"
              aria-selected={active}
              active={active}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </Pill>
          );
        })}
      </div>
    </>
  );
}
