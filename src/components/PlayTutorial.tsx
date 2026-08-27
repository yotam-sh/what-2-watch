"use client";

// One-time explainer for "Play on …", shown the first time someone reaches
// the verdict screen having picked something.
//
// Every line here is a real failure mode we hit while building this, not
// generic hand-holding:
//   - same network: commands go straight to the device over the LAN, so a
//     phone on mobile data silently reaches nothing.
//   - Plex open + "Advertise as player": the device is invisible otherwise,
//     and the toggle alone isn't enough — the app has to be restarted. This
//     one cost three rounds of debugging to find.
//   - takeover: a play command replaces whatever is already on. Plex gives
//     no warning of its own, so this is the only place a household learns
//     it before it happens to them.
//
// Same mechanics as SwipeTutorial: shown once per browser, portaled out to
// escape transformed ancestors, dismissed to localStorage.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Cast, Power, TriangleAlert, Wifi } from "lucide-react";
import { Button } from "@/components/ui/Button";

const STORAGE_KEY = "w2w.playTutorialSeen.v1";

function useHasSeen(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== null;
      } catch {
        return false;
      }
    },
    () => true,
  );
}

const STEPS = [
  { Icon: Wifi, label: "Same wifi", detail: "Your phone and the TV must be on the same network" },
  { Icon: Power, label: "Plex open on the TV", detail: "And Advertise as player enabled in its settings" },
  { Icon: Cast, label: "Tap Play on", detail: "It takes a few seconds to start" },
  { Icon: TriangleAlert, label: "Already watching?", detail: "Playing takes over — their place is saved" },
];

export function PlayTutorial() {
  const hasSeen = useHasSeen();
  const [dismissed, setDismissed] = useState(false);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Storage disabled — it'll show again, which is harmless.
    }
  }, []);

  const open = !hasSeen && !dismissed;

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
      aria-label="How to play on your TV"
      className="fixed inset-0 z-50 flex items-end justify-center bg-[color:var(--scrim)] p-4 backdrop-blur-[6px]"
    >
      <div className="safe-area-bottom w-full max-w-sm rounded-[16px] border border-line bg-elevated p-5 shadow-comet-xl">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary">One-time tip</p>
        <h2 className="mt-1 font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">
          Play it on your TV
        </h2>

        <ul className="mt-4 flex flex-col gap-3">
          {STEPS.map(({ Icon, label, detail }) => (
            <li key={label} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              </span>
              <span className="min-w-0 text-[13px] text-body">
                <span className="font-semibold">{label}</span>
                <span className="block text-secondary">{detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <Button onClick={dismiss} variant="primary" size="lg" className="mt-5 w-full">
          Got it
        </Button>
      </div>
    </div>,
    document.body,
  );
}
