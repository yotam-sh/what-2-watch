// The comet mark plus the product name. The mark is a violet head with a
// tapering trail sweeping up-right, filled with the signature violet→coral
// gradient — the one place in the app those two colours meet.
//
// The gradient's id is derived from `size` rather than useId() so this stays
// a plain function with no hooks (and therefore renders in a Server
// Component). Two Wordmarks of the same size on one page would collide, but
// there is never more than one per screen: `sm` in chrome, `lg` on sign-in.
const SIZES = {
  sm: { mark: 18, text: "text-base" },
  lg: { mark: 36, text: "text-[28px]" },
} as const;

export function Wordmark({ size = "sm" }: { size?: keyof typeof SIZES }) {
  const { mark, text } = SIZES[size];
  const gradientId = `comet-mark-${size}`;

  return (
    <span className="inline-flex items-center gap-2">
      <svg
        width={mark}
        height={mark}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <defs>
          {/* 105deg, expressed in objectBoundingBox units. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0.27">
            <stop offset="0%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#ff9d6b" />
          </linearGradient>
        </defs>
        <path d="M8.4 11.4Q15 7 22 2Q17 9 12.6 15.6Z" fill={`url(#${gradientId})`} />
        <circle cx="8.5" cy="15.5" r="4" fill={`url(#${gradientId})`} />
      </svg>
      <span className={`font-display font-semibold tracking-[-0.02em] text-heading ${text}`}>
        what<span className="text-accent">2</span>watch
      </span>
    </span>
  );
}
