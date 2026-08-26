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
import { Link2Off, SearchX } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { plexItems, titles } from "@/db/schema";
import { SyncButton } from "@/components/SyncButton";
import { TitleCard } from "@/components/TitleCard";
import { buttonClasses } from "@/components/ui/Button";
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
      <header className="px-4 pt-6 pb-3">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Rewatch</h1>
        <p className="text-[13px] text-secondary">Sorted by how long it&apos;s been since you last watched.</p>
      </header>

      {!hasSyncedAnything ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <Link2Off className="h-[22px] w-[22px] text-muted" strokeWidth={2} aria-hidden="true" />
          <h2 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">
            Nothing synced yet
          </h2>
          <p className="max-w-xs text-[13px] text-secondary">
            Link Plex in Settings and run a sync to see titles you&apos;ve already watched.
          </p>
          <Link href="/settings" className={buttonClasses({ variant: "primary" })}>
            Go to Settings
          </Link>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <SearchX className="h-[22px] w-[22px] text-muted" strokeWidth={2} aria-hidden="true" />
          <h2 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">
            No watched titles yet
          </h2>
          <p className="max-w-xs text-[13px] text-secondary">
            Your Plex library synced, but nothing has a confirmed watch yet. Watch something, then
            sync again.
          </p>
          <SyncButton endpoints={["/api/plex/sync"]} />
        </div>
      ) : (
        // The meta line drops its "Last watched " prefix here: the header
        // above already frames every date on this screen, and an 11px mono
        // string has roughly 110px of cell to live in.
        <ul className="grid grid-cols-3 gap-3 px-4 sm:grid-cols-4">
          {list.map((item) => (
            <TitleCard
              key={titleKey(item)}
              title={item.title}
              year={item.year}
              posterPath={item.posterPath}
              meta={formatRelativeTime(item.lastWatchedAt)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
