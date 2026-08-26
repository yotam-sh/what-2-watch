// A hairline-bordered surface floating on the void — the core Comet shape.
//
// There is deliberately no `interactive` variant. The design system defines
// one (a 2px lift and a violet border on hover), but nothing in this app has
// a tappable card: Settings' cards are containers for controls, not controls
// themselves. A card that lifts under the thumb and then does nothing is a
// lie, so the variant lands when something actually needs it.
import type { ReactNode } from "react";

export function Card({
  header,
  className = "",
  children,
}: {
  /** Optional header slot, separated from the body by a soft divider. */
  header?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-[12px] border border-line bg-card shadow-comet-md ${className}`}>
      {header && <div className="border-b border-line-soft px-5 py-4">{header}</div>}
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

/** Card header convention: display-font title, optional secondary sub-line. */
export function CardHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="font-display text-base font-semibold tracking-[-0.01em] text-heading">{title}</h2>
      {sub && <p className="text-xs text-secondary">{sub}</p>}
    </div>
  );
}
