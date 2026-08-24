"use client";

// Thumb-reachable bottom tab bar for the five core screens. Fixed to the
// bottom of the viewport (not the top) deliberately — that's the reachable
// zone on a phone held one-handed, which is the whole "mobile-first" brief.
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
      className="safe-area-bottom fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between px-1">
        {TABS.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                className={`tap-target flex flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors ${
                  active ? "text-brand" : "text-zinc-500 dark:text-zinc-400"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="h-6 w-6" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
