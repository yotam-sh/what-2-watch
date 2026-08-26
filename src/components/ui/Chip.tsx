// A filter value inside the bottom sheet. Toggles, so it carries
// aria-pressed; active state is a soft violet fill rather than a solid one,
// because a sheet full of solid violet reads as noise. Pill.tsx is the
// heavier sibling used for the Decide mode row.
//
// StaticChip (the "why" tags under a Decide poster) renders as a plain list
// item rather than a button — those explain a result, they don't change one,
// and a button that does nothing when tapped is worse than a label.
import type { ReactNode } from "react";

const CHIP_BASE =
  "tap-target inline-flex shrink-0 items-center justify-center rounded-full border px-3 text-xs font-medium transition-colors duration-[180ms] ease-out";

const CHIP_ACTIVE = "border-[color:var(--accent-line)] bg-accent-soft text-accent";
const CHIP_INACTIVE = "border-line text-secondary hover:bg-hover hover:text-body";

export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
    >
      {children}
    </button>
  );
}

/** Non-interactive Chip, styled as active. For the Decide card's "why" tags. */
export function StaticChip({ children }: { children: ReactNode }) {
  return (
    <li
      className={`inline-flex shrink-0 items-center justify-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${CHIP_ACTIVE}`}
    >
      {children}
    </li>
  );
}
