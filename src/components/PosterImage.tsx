// Renders a TMDB poster directly from TMDB's own public image CDN.
//
// NOTE ON /api/plex/image: that route proxies a *Plex-relative* thumb path
// (e.g. "/library/metadata/123/thumb/456") using the caller's own linked
// server connection — it exists for Plex-native artwork, never for TMDB
// paths. Every candidate this UI renders comes from `titles.posterPath`
// (src/db/schema.ts), which is TMDB's `poster_path` (mapper.ts), a small
// public, unauthenticated CDN path — not a Plex-relative one. Passing a TMDB
// path to /api/plex/image would just 400 (isSafeRelativePath requires a
// Plex-style path) or 502 (wrong server entirely) — the two systems don't
// share a URL shape. Sourcing straight from image.tmdb.org is both correct
// and simpler, and doubles as the thing sw.js's POSTER_CACHE cache-firsts.
import type { ImgHTMLAttributes } from "react";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";

export interface PosterImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> {
  posterPath: string | null;
  title: string;
}

export function PosterImage({ posterPath, title, className, ...rest }: PosterImageProps) {
  if (!posterPath) {
    return (
      <div
        className={`flex items-center justify-center bg-zinc-200 p-3 text-center text-sm font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 ${className ?? ""}`}
      >
        {title}
      </div>
    );
  }

  // Plain <img>, not next/image: the service worker's cache-first poster
  // strategy (sw.js's POSTER_CACHE) needs to intercept a real <img> network
  // request directly; next/image's client-side loader/srcset rewriting
  // would fight that.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${TMDB_IMAGE_BASE}${posterPath}`}
      alt={`${title} poster`}
      loading="lazy"
      className={`object-cover ${className ?? ""}`}
      {...rest}
    />
  );
}
