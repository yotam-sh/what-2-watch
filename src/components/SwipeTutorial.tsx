"use client";

// One-time "here's how this works" card for the Decide screen.
//
// It exists because the phone layout deliberately has no visible verdict
// buttons — the three swipes ARE the interface there (see DecideScreen), and
// an interface with no affordances needs exactly one moment of explanation.
// Shown once per browser, dismissed forever.
//
// Phone only (`sm:hidden`): on a wide screen the real buttons are visible
// and a swipe tutorial would be describing controls that aren't in use.
// Using a CSS breakpoint rather than a JS media query keeps this SSR-safe —
// no matchMedia, no hydration branch. Consequence, deliberately: a desktop
// visit can't dismiss it, so a later phone visit still gets the tutorial.
//
// Portaled to document.body for the same reason FilterSheet is — see the
// long comment there about transformed ancestors capturing `position:
// fixed`. DecideScreen's <main> carries animate-content-in.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, ArrowUp, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";

const STORAGE_KEY = "w2w.swipeTutorialSeen.v1";

/** Reads localStorage through useSyncExternalStore rather than an effect:
 *  returns the server snapshot (true = "seen", so nothing renders during
 *  SSR and the first client render matches) and the real value once
 *  hydrated. Same pattern, and same reasoning, as FilterSheet's `mounted`. */
function useHasSeenTutorial(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== null;
      } catch {
        // Private mode / storage disabled. Showing the tutorial every time
        // is a far better failure than crashing the Decide screen.
        return false;
      }
    },
    () => true,
  );
}

const STEPS = [
  { Icon: ArrowLeft, label: "Swipe left", detail: "Not tonight" },
  { Icon: ArrowRight, label: "Swipe right", detail: "Maybe later" },
  { Icon: ArrowUp, label: "Swipe up", detail: "Watch this" },
  { Icon: RotateCw, label: "Tap ↻", detail: "Roll again, no verdict" },
];

export function SwipeTutorial() {
  const hasSeen = useHasSeenTutorial();
  const [dismissed, setDismissed] = useState(false);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Nothing to do — it'll show again next time, which is harmless.
    }
  }, []);

  const open = !hasSeen && !dismissed;

  // Escape dismisses, matching every other overlay in the app.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, dismiss]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="How to use Decide"
      className="fixed inset-0 z-50 flex items-end justify-center bg-[color:var(--scrim)] p-4 backdrop-blur-[6px] sm:hidden"
    >
      <div className="safe-area-bottom w-full max-w-sm rounded-[16px] border border-line bg-elevated p-5 shadow-comet-xl">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary">Quick start</p>
        <h2 className="mt-1 font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">
          Swipe to decide
        </h2>

        <ul className="mt-4 flex flex-col gap-3">
          {STEPS.map(({ Icon, label, detail }) => (
            <li key={label} className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              </span>
              <span className="min-w-0 text-[13px] text-body">
                <span className="font-semibold">{label}</span>
                <span className="text-secondary"> — {detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs text-secondary">
          Up top: pick a mode (Discover, Rewatch, Binge…) and tap the funnel to filter by runtime,
          decade or genre.
        </p>

        <Button onClick={dismiss} variant="primary" size="lg" className="mt-5 w-full">
          Got it
        </Button>
      </div>
    </div>,
    document.body,
  );
}
