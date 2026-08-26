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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { IconButton } from "@/components/ui/IconButton";
import { Sheet } from "@/components/ui/Sheet";
import {
  filtersReducer,
  hasActiveFilters,
  type DecideFilters,
  type FilterAction,
} from "@/lib/ui/filters";
import { QUICK_DECADES, QUICK_GENRES, QUICK_RUNTIMES } from "@/lib/ui/modes";
import { CloseIcon } from "./icons";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary">{label}</h3>
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
  // Portal target only exists in the browser — `document` is undefined
  // during SSR/RSC render. Starting `mounted` false makes the very first
  // client render match the server's (both render nothing here), so this
  // never trips a hydration mismatch; the effect below flips it true right
  // after mount and the sheet mounts into document.body from then on. See
  // the return statement for why this must portal at all.
  // useSyncExternalStore is React's sanctioned way to read a client-only
  // value: it returns the server snapshot (false) during SSR and the client
  // snapshot (true) once hydrated, with no setState-in-effect and no
  // cascading render. The store never changes, so subscribe is a no-op.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
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

  // Portaled to document.body rather than rendered in place: the Sheet shell
  // this renders (src/components/ui/Sheet.tsx — visual only; every hook and
  // handler stays in this file) is `fixed inset-0`, but DecideScreen renders
  // this component inside a <main
  // className="... animate-content-in"> — and animate-content-in applies a
  // CSS transform. Per spec, a transformed ancestor becomes the containing
  // block for a `position: fixed` descendant, so without the portal this
  // sheet would position itself against <main> (which grows taller than
  // the viewport as content is added) instead of the viewport itself,
  // making it scroll inline instead of overlaying. Escaping to document.body
  // sidesteps that permanently, regardless of what transforms ever end up
  // between here and the root. (Refs, event handlers, and context all still
  // work normally through a portal — only the DOM location changes.)
  if (!mounted) return null;

  return createPortal(
    <Sheet
      open={open}
      onClose={onClose}
      label="Filters"
      title="Filters"
      dialogRef={dialogRef}
      headerAction={
        <IconButton onClick={onClose} aria-label="Close filters" className="-mr-2">
          <CloseIcon className="h-5 w-5" strokeWidth={2} />
        </IconButton>
      }
      footer={
        <>
          <Button
            onClick={() => dispatch({ type: "RESET" })}
            disabled={!stagedHasActive}
            variant="secondary"
            className="flex-1"
          >
            Reset
          </Button>
          <Button onClick={() => onApply(staged)} variant="primary" className="flex-1">
            Apply
          </Button>
        </>
      }
    >
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
    </Sheet>,
    document.body,
  );
}
