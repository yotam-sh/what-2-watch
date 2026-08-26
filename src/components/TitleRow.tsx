// Row for /continue, the one browse screen that stays a list rather than a
// poster grid: how far through something you are is the whole point there,
// and a progress track needs a row to live in. Rewatch and Watchlist use
// TitleCard.tsx instead.
//
// No client interactivity of its own, so it renders fine as part of a Server
// Component page.
import { PosterImage } from "./PosterImage";

export function TitleRow({
  title,
  year,
  runtime,
  posterPath,
  meta,
  percent,
}: {
  title: string;
  year: number | null;
  runtime: number | null;
  posterPath: string | null;
  meta?: string;
  /** 0–100, or null when runtime is unknown and progress can't be computed. */
  percent?: number | null;
}) {
  return (
    <li className="flex gap-3 border-b border-line-soft px-4 py-2.5 transition-colors duration-[180ms] ease-out hover:bg-card">
      <div
        style={{ boxShadow: "inset 0 0 0 1px var(--hairline-inset)" }}
        className="h-24 w-16 shrink-0 overflow-hidden rounded-[10px] bg-elevated"
      >
        <PosterImage posterPath={posterPath} title={title} className="h-full w-full" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <p className="truncate text-sm font-medium text-body">
          {title}
          {year ? ` (${year})` : ""}
        </p>
        <p className="font-mono text-[11px] tabular-nums text-muted">
          {[runtime ? `${runtime} min` : null, meta].filter(Boolean).join(" · ")}
        </p>
        {/* No empty track when progress is unknown: a 0%-filled bar reads as
            "you've watched none of this", which is the opposite of what an
            in-progress item with an unknown runtime means. The meta line
            above still says "In progress". */}
        {percent !== null && percent !== undefined && (
          <div
            className="h-[3px] w-full overflow-hidden rounded-full bg-inset"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${title} watch progress`}
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
    </li>
  );
}
