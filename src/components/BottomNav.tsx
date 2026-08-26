"use client";

// Thumb-reachable bottom tab bar for the five core screens. Fixed to the
// bottom of the viewport (not the top) deliberately — that's the reachable
// zone on a phone held one-handed, which is the whole "mobile-first" brief.
//
// The active tab is marked twice over: violet text/icon *and* a 2px
// indicator bar above the glyph. Colour alone is a weak signal for anyone
// with a colour-vision deficiency, and violet-on-near-black is exactly the
// pairing that suffers.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookmarkIcon, DiceIcon, HistoryIcon, PlayCircleIcon, SlidersIcon } from "./icons";

const TABS = [
  { href: "/", label: "Decide", Icon: DiceIcon },
  { href: "/rewatch", label: "Rewatch", Icon: HistoryIcon },
  { href: "/watchlist", label: "Watchlist", Icon: BookmarkIcon },
  { href: "/continue", label: "Continue", Icon: PlayCircleIcon },
  { href: "/settings", label: "Settings", Icon: SlidersIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      // color-mix rather than a /88 opacity utility so the blur has an
      // actual translucent ground to work against in every browser that
      // supports backdrop-filter.
      style={{ background: "color-mix(in oklab, var(--color-bg) 88%, transparent)" }}
      className="safe-area-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line-soft backdrop-blur-[14px]"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between px-1">
        {TABS.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                className={`tap-target flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors duration-[120ms] ease-out ${
                  active ? "text-accent" : "text-muted hover:text-secondary"
                }`}
                aria-current={active ? "page" : undefined}
              >
                {/* Always rendered, transparent when inactive: conditionally
                    mounting the indicator would shift every icon down by its
                    height the moment the active tab changed. */}
                <span
                  aria-hidden="true"
                  className={`h-0.5 w-4 rounded-full ${active ? "bg-accent" : "bg-transparent"}`}
                />
                <Icon className="h-5 w-5" strokeWidth={2} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
