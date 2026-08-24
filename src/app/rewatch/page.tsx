// /rewatch — browse watched titles sorted by how long since last watch
// (oldest first: the ones most "due" for a rewatch surface first).
//
// Implemented as a Server Component reading straight from the DB via
// getReconciledWatchHistory() (src/lib/reconcile.ts) rather than through
// POST /api/recommend: that endpoint's rewatch mode returns a small,
// score-and-jitter-ranked, "roll again"-flavored batch (by design — see
// recommend.ts's file header) with no lastWatchedAt in its response shape
// at all, so it cannot honestly satisfy "sorted by how long since last
// watch." Reading the same tables recommend.ts itself reads, with a plain
// chronological sort, is the correct fit for a *browse* screen — this is a
// UI-consumption choice, not a change to any src/lib/** module.
//
// Pool matches recommend.ts's own "rewatch" mode definition: viewCount >= 1
// in plex_items (a Plex-confirmed watch), not just any watch_events row —
// see that file's buildCandidatePool() comment for why a Letterboxd-only
// watch doesn't count here either.
import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { plexItems, titles } from "@/db/schema";
import { SyncButton } from "@/components/SyncButton";
import { TitleRow } from "@/components/TitleRow";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { titleKey, type MediaType } from "@/lib/ml/key";
import { getReconciledWatchHistory } from "@/lib/reconcile";
import { formatRelativeTime } from "@/lib/ui/relativeTime";

async function loadRewatchList(userId: string) {
  const history = getReconciledWatchHistory(userId);
  const plexRows = db.select().from(plexItems).where(eq(plexItems.userId, userId)).all();

  const viewCountByKey = new Map<string, number>();
  for (const row of plexRows) {
    if (row.tmdbId === null || row.mediaType === null) continue;
    const key = titleKey({ tmdbId: row.tmdbId, mediaType: row.mediaType as MediaType });
    viewCountByKey.set(key, Math.max(viewCountByKey.get(key) ?? 0, row.viewCount ?? 0));
  }

  const plexConfirmed = history.filter((h) => (viewCountByKey.get(titleKey(h)) ?? 0) >= 1);

  const allTitles = db.select().from(titles).all();
  const titleByKey = new Map(allTitles.map((t) => [titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }), t]));

  return plexConfirmed
    .map((h) => {
      const t = titleByKey.get(titleKey(h));
      return {
        tmdbId: h.tmdbId,
        mediaType: h.mediaType,
        title: h.title,
        year: h.year,
        runtime: t?.runtime ?? null,
        posterPath: t?.posterPath ?? null,
        lastWatchedAt: h.lastWatchedAt,
      };
    })
    .sort((a, b) => a.lastWatchedAt.getTime() - b.lastWatchedAt.getTime());
}

export default async function RewatchPage() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/");
    throw err;
  }

  const plexLink = db.select().from(plexItems).where(eq(plexItems.userId, user.id)).limit(1).all();
  const hasSyncedAnything = plexLink.length > 0;
  const list = hasSyncedAnything ? await loadRewatchList(user.id) : [];

  return (
    <main className="min-h-screen-dvh pb-6 animate-content-in">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold">Rewatch</h1>
        <p className="text-sm text-zinc-500">Sorted by how long it&apos;s been since you last watched.</p>
      </header>

      {!hasSyncedAnything ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">Nothing synced yet</h2>
          <p className="max-w-xs text-zinc-500">
            Link Plex in Settings and run a sync to see titles you&apos;ve already watched.
          </p>
          <Link href="/settings" className="tap-target rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground">
            Go to Settings
          </Link>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">No watched titles yet</h2>
          <p className="max-w-xs text-zinc-500">
            Your Plex library synced, but nothing has a confirmed watch yet. Watch something, then
            sync again.
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
              meta={`Last watched ${formatRelativeTime(item.lastWatchedAt)}`}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
