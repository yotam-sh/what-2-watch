// A single figure with a label — used for the post-sync tallies in Settings.
// The 3px left edge is the one colored-left-border card in the whole design
// system; every other surface uses a uniform hairline.
//
// Not composed from Card.tsx: Card sets `border` on all four sides, and
// layering a `border-l-[3px]` override on top of that through className
// depends on Tailwind's utility sort order rather than anything stated, so
// the edge is declared directly here instead. Padding is 12px rather than
// Card's 20px because these render three-up on a 390px-wide phone — 20px a
// side leaves a 22px mono numeral nowhere to go.
import type { ReactNode } from "react";

export type StatTone = "accent" | "positive" | "negative" | "warning";

const EDGE: Record<StatTone, string> = {
  accent: "border-l-accent",
  positive: "border-l-positive",
  negative: "border-l-negative",
  warning: "border-l-warning",
};

export function StatCard({
  label,
  value,
  tone = "accent",
  icon,
}: {
  label: string;
  /** Rendered in mono with tabular-nums — every user-facing number does. */
  value: string | number;
  tone?: StatTone;
  icon?: ReactNode;
}) {
  return (
    <div
      className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-[12px] border border-line border-l-[3px] bg-card px-3 py-3 shadow-comet-md ${EDGE[tone]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary">{label}</span>
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
      </div>
      <span className="font-mono text-[22px] font-medium tabular-nums leading-none text-heading">{value}</span>
    </div>
  );
}
