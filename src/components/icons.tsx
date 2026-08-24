// Small hand-rolled stroke icon set for the bottom nav — no icon package is
// installed in this project, and pulling one in for five glyphs isn't worth
// the dependency. Deliberately simple shapes (circles/rects/lines) rather
// than detailed paths, consistent 24x24 viewBox, currentColor stroke so they
// pick up text color (and therefore the active/inactive tab styling) for
// free.
import type { SVGProps } from "react";

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

/** Decide — a die face, since the roll is the headline feature. */
export function DiceIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <circle cx="8.3" cy="8.3" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.7" cy="8.3" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8.3" cy="15.7" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.7" cy="15.7" r="1.1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Rewatch — a clock with a back-pointing sweep, standing in for "history". */
export function HistoryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3.5 9a8.5 8.5 0 1 1-1.2 5.5" />
      <path d="M2 5v4h4" />
      <path d="M12 8v4l3 2" />
    </Icon>
  );
}

/** Watchlist — a bookmark. */
export function BookmarkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z" />
    </Icon>
  );
}

/** Continue — a play button in a circle. */
export function PlayCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.5l6 3.5-6 3.5v-7Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Settings — three sliders, simpler and more legible at nav-icon size than
 *  a detailed gear. */
export function SlidersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="11" cy="18" r="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function SpinnerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props} className={`animate-spin ${props.className ?? ""}`}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Icon>
  );
}
