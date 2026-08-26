// /watchlist — browse titles from Plex Discover's watchlist (constraint 14 /
// the master plan: "watchlist comes from Plex Discover, not Letterboxd").
// Server Component reading watchlist_items directly, same rationale as
// /rewatch: a plain "most recently added first" browse doesn't need
// score/jitter ranking.
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { BookmarkX, Link2Off } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { plexLinks, titles, watchlistItems } from "@/db/schema";
import { SyncButton } from "@/components/SyncButton";
import { TitleCard } from "@/components/TitleCard";
import { buttonClasses } from "@/components/ui/Button";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { titleKey, type MediaType } from "@/lib/ml/key";
import { formatRelativeTime } from "@/lib/ui/relativeTime";

async function loadWatchlist(userId: string) {
  const rows = db
    .select()
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, userId))
    .orderBy(desc(watchlistItems.addedAt))
    .all();

  const allTitles = db.select().from(titles).all();
  const titleByKey = new Map(allTitles.map((t) => [titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }), t]));

  return rows.map((r) => {
    const t = titleByKey.get(titleKey({ tmdbId: r.tmdbId, mediaType: r.mediaType as MediaType }));
    return {
      tmdbId: r.tmdbId,
      mediaType: r.mediaType as MediaType,
      title: t?.title ?? `Unknown (${r.tmdbId})`,
      year: t?.year ?? null,
      runtime: t?.runtime ?? null,
      posterPath: t?.posterPath ?? null,
      addedAt: r.addedAt,
    };
  });
}

export default async function WatchlistPage() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/");
    throw err;
  }

  const link = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();
  const list = link ? await loadWatchlist(user.id) : [];

  return (
    <main className="min-h-screen-dvh pb-6 animate-content-in">
      <header className="px-4 pt-6 pb-3">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Watchlist</h1>
        <p className="text-[13px] text-secondary">From your Plex Discover watchlist.</p>
      </header>

      {!link ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <Link2Off className="h-[22px] w-[22px] text-muted" strokeWidth={2} aria-hidden="true" />
          <h2 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">
            Plex isn&apos;t linked
          </h2>
          <p className="max-w-xs text-[13px] text-secondary">
            The watchlist comes from Plex Discover — link your Plex account in Settings first.
          </p>
          <Link href="/settings" className={buttonClasses({ variant: "primary" })}>
            Go to Settings
          </Link>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <BookmarkX className="h-[22px] w-[22px] text-muted" strokeWidth={2} aria-hidden="true" />
          <h2 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">
            Your watchlist is empty
          </h2>
          <p className="max-w-xs text-[13px] text-secondary">
            Either nothing&apos;s on your Plex Discover watchlist, or it hasn&apos;t synced yet.
          </p>
          <SyncButton endpoints={["/api/plex/sync"]} />
        </div>
      ) : (
        // "Added " is dropped from the meta line for cell width — see the
        // matching note on /rewatch. The header above carries the framing.
        <ul className="grid grid-cols-3 gap-3 px-4 sm:grid-cols-4">
          {list.map((item) => (
            <TitleCard
              key={titleKey(item)}
              title={item.title}
              year={item.year}
              posterPath={item.posterPath}
              meta={formatRelativeTime(item.addedAt)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
