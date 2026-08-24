"use client";

// Mobile bottom sheet holding every Decide-screen filter control, plus
// Reset and Apply. Replaces the always-visible chip row that used to live
// directly on the Decide screen (formerly FilterBar.tsx) — see
// FilterButton.tsx for the trigger this opens from.
//
// Staged-until-Apply, deliberately: edits made inside the sheet are local
// (`staged` state below) and only committed to the screen's real filter
// state — and therefore only sent to /api/recommend — when Apply is
// pressed. Dismissing via backdrop, the close button, or Escape discards
// whatever was changed since the sheet opened. This is the coherent
// pairing for a sheet that *has* an Apply button: if edits applied live,
// Apply would have nothing left to do.
import { useEffect, useRef, useState } from "react";
import {
  filtersReducer,
  hasActiveFilters,
  type DecideFilters,
  type FilterAction,
} from "@/lib/ui/filters";
import { QUICK_DECADES, QUICK_GENRES, QUICK_RUNTIMES } from "@/lib/ui/modes";
import { CloseIcon } from "./icons";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`tap-target shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-brand bg-brand/10 text-brand dark:bg-brand/20"
          : "border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
      }`}
    >
      {children}
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function FilterSheet({
  open,
  committedFilters,
  onApply,
  onClose,
  returnFocusRef,
}: {
  open: boolean;
  committedFilters: DecideFilters;
  onApply: (filters: DecideFilters) => void;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [staged, setStaged] = useState<DecideFilters>(committedFilters);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Two independent "was it open last render" refs, each owned by its own
  // effect below — sharing one ref between effects would make whichever
  // effect runs second observe a value the first has already overwritten.
  const wasOpenForReseedRef = useRef(open);
  const wasOpenForFocusReturnRef = useRef(open);

  // Re-seed the staged draft from the committed filters every time the
  // sheet transitions from closed to open, not on every render — otherwise
  // a `committedFilters` identity change (which only happens via Apply,
  // which itself closes the sheet) would never actually matter, but this
  // keeps the intent explicit rather than relying on that coincidence.
  useEffect(() => {
    if (open && !wasOpenForReseedRef.current) {
      setStaged(committedFilters);
    }
    wasOpenForReseedRef.current = open;
  }, [open, committedFilters]);

  // Body scroll lock while the sheet is open, restored on close/unmount.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Focus in on open, trap Tab while open, Escape to dismiss.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    getFocusable()[0]?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const elements = getFocusable();
      if (elements.length === 0) return;
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Return focus to the Filters button whenever the sheet closes, no
  // matter which of the three dismiss paths (backdrop/close button/Escape)
  // or Apply triggered it. Guarded on the open->closed transition (rather
  // than just "!open") so this doesn't steal focus back on first mount,
  // when the sheet starts closed and nothing was ever focused inside it.
  useEffect(() => {
    if (wasOpenForFocusReturnRef.current && !open) {
      returnFocusRef.current?.focus();
    }
    wasOpenForFocusReturnRef.current = open;
  }, [open, returnFocusRef]);

  const dispatch = (action: FilterAction) => setStaged((prev) => filtersReducer(prev, action));
  const stagedHasActive = hasActiveFilters(staged);

  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} inert={!open}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Sheet */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        className={`absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-xl bg-white shadow-lg transition-transform duration-200 dark:bg-zinc-950 ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-base font-semibold">Filters</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="tap-target -mr-2 flex items-center justify-center rounded-md text-zinc-500 dark:text-zinc-400"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-4 py-4">
          <Section label="Runtime">
            {QUICK_RUNTIMES.map((option) => (
              <Chip
                key={option.label}
                active={staged.maxRuntimeMinutes === option.minutes}
                onClick={() => dispatch({ type: "SET_MAX_RUNTIME", minutes: option.minutes })}
              >
                {option.label}
              </Chip>
            ))}
          </Section>

          <Section label="Decade">
            {QUICK_DECADES.map((option) => (
              <Chip
                key={option.label}
                active={staged.decade === option.decade}
                onClick={() => dispatch({ type: "SET_DECADE", decade: option.decade })}
              >
                {option.label}
              </Chip>
            ))}
          </Section>

          <Section label="Genre">
            <Chip active={staged.genre === null} onClick={() => dispatch({ type: "SET_GENRE", genre: null })}>
              Any genre
            </Chip>
            {QUICK_GENRES.map((genre) => (
              <Chip
                key={genre}
                active={staged.genre === genre}
                onClick={() => dispatch({ type: "SET_GENRE", genre: staged.genre === genre ? null : genre })}
              >
                {genre}
              </Chip>
            ))}
          </Section>
        </div>

        <div className="safe-area-bottom flex gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => dispatch({ type: "RESET" })}
            disabled={!stagedHasActive}
            className="tap-target flex-1 rounded-md border border-zinc-300 py-2.5 text-sm font-medium disabled:opacity-40 dark:border-zinc-700"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => onApply(staged)}
            className="tap-target flex-1 rounded-md bg-brand py-2.5 text-sm font-semibold text-brand-foreground"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
