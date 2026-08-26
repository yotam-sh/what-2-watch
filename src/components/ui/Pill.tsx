// The Decide screen's mode row. Shaped like a Chip but weighted heavier:
// one of these is always selected, and the selection is the screen's primary
// state, so active is a solid violet fill rather than Chip's soft tint — it
// has to win against a full-bleed poster sitting right below it.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Pill({
  active,
  onClick,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tap-target inline-flex h-[38px] shrink-0 items-center justify-center rounded-full px-4 text-[13px] transition-colors duration-[180ms] ease-out ${
        active
          ? "bg-accent font-semibold text-accent-contrast"
          : "border border-line bg-card text-secondary hover:bg-hover hover:text-body"
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}
