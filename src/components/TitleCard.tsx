// Grid cell for the browse screens that are about *choosing* — Rewatch and
// Watchlist. Those are poster-recognition tasks: you scan a wall of artwork
// and stop when something catches you, which a full-width row list actively
// fights by showing three items per screen. Continue keeps TitleRow.tsx
// instead, because progress is the point there and a progress bar needs a
// row to live in.
//
// No client interactivity of its own, so it renders fine as part of a Server
// Component page — same as TitleRow.
import { PosterImage } from "./PosterImage";

export function TitleCard({
  title,
  year,
  posterPath,
  meta,
}: {
  title: string;
  year: number | null;
  posterPath: string | null;
  meta?: string;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <div
        // Inset hairline so poster artwork has a defined edge against the
        // void — the same treatment the Decide card gets.
        style={{ boxShadow: "inset 0 0 0 1px var(--hairline-inset)" }}
        className="aspect-[2/3] w-full overflow-hidden rounded-[10px] bg-elevated"
      >
        <PosterImage posterPath={posterPath} title={title} className="h-full w-full" />
      </div>
      <p className="line-clamp-2 text-xs leading-snug text-body">
        {title}
        {year ? ` (${year})` : ""}
      </p>
      {meta && <p className="font-mono text-[11px] tabular-nums text-muted">{meta}</p>}
    </li>
  );
}
