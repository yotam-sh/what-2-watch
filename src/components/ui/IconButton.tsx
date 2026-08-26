// Square icon-only button — the filter sheet's close control and anything
// else that's a glyph with no label. Nominally 38px; `.tap-target` raises it
// to 44 in practice (see the note in Button.tsx). An aria-label is required,
// not optional: there is no text for a screen reader to fall back on.
import type { ButtonHTMLAttributes } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
}

export function IconButton({ className = "", type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={`tap-target inline-flex h-[38px] w-[38px] items-center justify-center rounded-[10px] text-secondary transition-colors duration-[180ms] ease-out hover:bg-hover hover:text-body active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    />
  );
}
