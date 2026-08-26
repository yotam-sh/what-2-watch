// The bottom-sheet *shell* — scrim, panel, drag handle, header, scrollable
// body, sticky footer. Visual only, on purpose.
//
// Everything that makes a sheet actually work — the portal to document.body,
// the focus trap, the body scroll lock, Escape-to-dismiss, and the
// staged-until-Apply draft state — stays in FilterSheet.tsx, which owns the
// hooks. This file owns nothing but classNames and slots, which is why it
// has no "use client" of its own and no state.
//
// `dialogRef` is threaded through rather than created here because
// FilterSheet's focus trap queries the panel's focusable children on every
// Tab keypress; the ref has to belong to the component running that effect.
import type { ReactNode, RefObject } from "react";

export function Sheet({
  open,
  onClose,
  label,
  title,
  dialogRef,
  headerAction,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  /** Visible heading. */
  title: string;
  dialogRef: RefObject<HTMLDivElement | null>;
  headerAction?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} inert={!open}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`absolute inset-0 bg-[color:var(--scrim)] backdrop-blur-[6px] transition-opacity duration-[180ms] ease-out ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Sheet */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-[16px] border-t border-line-strong bg-elevated shadow-comet-xl transition-transform duration-[180ms] ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {/* Drag handle — an affordance, not a control. There is no drag
            gesture wired to it; it reads as "this panel came up from the
            bottom and goes back down", which is what the backdrop tap and
            the close button already do. */}
        <div aria-hidden="true" className="flex justify-center pt-2.5">
          <div className="h-1 w-9 rounded-full bg-[color:var(--border-strong)]" />
        </div>

        <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
          <h2 className="font-display text-base font-semibold tracking-[-0.01em] text-heading">{title}</h2>
          {headerAction}
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <div className="safe-area-bottom flex gap-2 border-t border-line-soft bg-elevated px-4 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
