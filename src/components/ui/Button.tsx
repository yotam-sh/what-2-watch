// Comet's button. `buttonClasses` is exported separately from the component
// because several call sites need button *styling* on something that isn't a
// <button> — most of the empty states link to /settings with next/link, and
// those pages are Server Components, so they can't hand an onClick to
// anything. Sharing the class string keeps a styled <Link> and a real
// <button> visually identical without duplicating the variant table.
//
// SIZE vs. TAP TARGET: the design heights are 30/38/46px, but every
// interactive control in this app carries `.tap-target` (min 44px square,
// per Apple/Google accessibility guidance — see globals.css). min-height
// wins over height in CSS, so `sm` and `md` render at 44px in practice and
// only `lg` shows its nominal 46. That's deliberate and matches what shipped
// before the re-skin; the size prop still drives text size and horizontal
// padding, which is what actually carries the visual hierarchy on a phone.
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "glow" | "secondary" | "ghost" | "danger" | "danger-solid";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-contrast font-semibold hover:bg-accent-hover",
  // Reserved for exactly one control in the entire app — Decide's "Watch
  // this". Nothing else may be coral; if a second button wants emphasis, it
  // gets violet. See the anti-drift rules in the Comet brief.
  glow: "bg-glow text-glow-contrast font-semibold shadow-comet-glow hover:opacity-90",
  secondary: "bg-card border border-line text-body hover:bg-hover hover:border-[color:var(--accent-line)]",
  ghost: "bg-transparent text-secondary hover:bg-hover hover:text-body",
  danger: "bg-transparent border border-negative text-negative hover:bg-[color:var(--negative-soft)]",
  "danger-solid": "bg-negative text-void font-semibold hover:opacity-90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-[30px] px-3 text-xs",
  md: "h-[38px] px-4 text-[13px]",
  lg: "h-[46px] px-5 text-[15px]",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return [
    "tap-target inline-flex items-center justify-center gap-2 rounded-[10px]",
    "transition-colors duration-[180ms] ease-out active:translate-y-px",
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-inherit",
    SIZES[size],
    VARIANTS[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClasses({ variant, size, className })} {...rest} />;
}
