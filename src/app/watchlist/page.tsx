// /watchlist — browse titles from Plex Discover's watchlist (constraint 14 /
// the master plan: "watchlist comes from Plex Discover, not Letterboxd").
// Server Component reading watchlist_items directly, same rationale as
// /rewatch: a plain "most recently added first" browse doesn't need
// score/jitter ranking.
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { plexLinks, titles, watchlistItems } from "@/db/schema";
import { SyncButton } from "@/components/SyncButton";
import { TitleRow } from "@/components/TitleRow";
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
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold">Watchlist</h1>
        <p className="text-sm text-zinc-500">From your Plex Discover watchlist.</p>
      </header>

      {!link ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">Plex isn&apos;t linked</h2>
          <p className="max-w-xs text-zinc-500">
            The watchlist comes from Plex Discover — link your Plex account in Settings first.
          </p>
          <Link href="/settings" className="tap-target rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground">
            Go to Settings
          </Link>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">Your watchlist is empty</h2>
          <p className="max-w-xs text-zinc-500">
            Either nothing&apos;s on your Plex Discover watchlist, or it hasn&apos;t synced yet.
          </p>
          <SyncButton endpoints={["/api/plex/sync"]} />
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {list.map((item) => (
            <TitleRow
              key={titleKey(item)}
              title={item.title}
              year={item.year}
              runtime={item.runtime}
              posterPath={item.posterPath}
              meta={`Added ${formatRelativeTime(item.addedAt)}`}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
