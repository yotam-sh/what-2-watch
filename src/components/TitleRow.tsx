// Shared presentational row for the browse screens (Rewatch/Watchlist/
// Continue) — no client interactivity of its own, so it renders fine as
// part of a Server Component page.
import { PosterImage } from "./PosterImage";

export function TitleRow({
  title,
  year,
  runtime,
  posterPath,
  meta,
}: {
  title: string;
  year: number | null;
  runtime: number | null;
  posterPath: string | null;
  meta?: string;
}) {
  return (
    <li className="flex gap-3 px-4 py-2.5">
      <div className="h-24 w-16 shrink-0 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
        <PosterImage posterPath={posterPath} title={title} className="h-full w-full" />
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-0.5">
        <p className="truncate font-medium">
          {title}
          {year ? ` (${year})` : ""}
        </p>
        <p className="text-xs text-zinc-500">
          {[runtime ? `${runtime} min` : null, meta].filter(Boolean).join(" · ")}
        </p>
      </div>
    </li>
  );
}
