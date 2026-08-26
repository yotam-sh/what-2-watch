// Small non-interactive status pill. Deliberately has no tap-target: it's a
// label, never a control, so it stays at its nominal 20px.
//
// Semantic hues carry meaning only — positive for confirmed/linked, negative
// for failed, warning for caution, accent for a count worth noticing. None
// of them are decorative.
import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone = "accent" | "positive" | "negative" | "warning" | "neutral";

const TONES: Record<BadgeTone, string> = {
  accent: "bg-accent-soft text-accent",
  positive: "bg-[color:var(--positive-soft)] text-positive",
  negative: "bg-[color:var(--negative-soft)] text-negative",
  warning: "bg-[color:var(--warning-soft)] text-warning",
  neutral: "bg-elevated text-secondary",
};

export function Badge({
  tone = "neutral",
  className = "",
  children,
  ...rest
}: {
  tone?: BadgeTone;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center justify-center rounded-full px-2 text-[11px] font-semibold ${TONES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
