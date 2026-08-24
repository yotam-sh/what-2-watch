// /continue — in-progress items (viewOffset set, viewCount 0 — see
// isInProgress() in src/lib/plex/library.ts). Server Component reading
// plex_items directly, same rationale as /rewatch and /watchlist.
import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { plexItems, plexLinks, titles } from "@/db/schema";
import { SyncButton } from "@/components/SyncButton";
import { TitleRow } from "@/components/TitleRow";
import { requireUser, UnauthenticatedError } from "@/lib/auth/guards";
import { titleKey, type MediaType } from "@/lib/ml/key";
import { isInProgress } from "@/lib/plex/library";

async function loadContinueList(userId: string) {
  const rows = db.select().from(plexItems).where(eq(plexItems.userId, userId)).all();
  const allTitles = db.select().from(titles).all();
  const titleByKey = new Map(allTitles.map((t) => [titleKey({ tmdbId: t.tmdbId, mediaType: t.mediaType as MediaType }), t]));

  const inProgress = rows.filter(
    (r) =>
      r.tmdbId !== null &&
      r.mediaType !== null &&
      isInProgress({ viewCount: r.viewCount ?? 0, viewOffset: r.viewOffset ?? undefined }),
  );

  return inProgress
    .map((r) => {
      const mediaType = r.mediaType as MediaType;
      const t = titleByKey.get(titleKey({ tmdbId: r.tmdbId!, mediaType }));
      const runtimeMs = t?.runtime ? t.runtime * 60_000 : null;
      const percent = runtimeMs && r.viewOffset ? Math.min(100, Math.round((r.viewOffset / runtimeMs) * 100)) : null;
      return {
        tmdbId: r.tmdbId!,
        mediaType,
        title: t?.title ?? `Unknown (${r.tmdbId})`,
        year: t?.year ?? null,
        runtime: t?.runtime ?? null,
        posterPath: t?.posterPath ?? null,
        percent,
        lastViewedAt: r.lastViewedAt,
      };
    })
    .sort((a, b) => (b.lastViewedAt?.getTime() ?? 0) - (a.lastViewedAt?.getTime() ?? 0));
}

export default async function ContinuePage() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect("/");
    throw err;
  }

  const link = db.select().from(plexLinks).where(eq(plexLinks.userId, user.id)).get();
  const list = link ? await loadContinueList(user.id) : [];

  return (
    <main className="min-h-screen-dvh pb-6 animate-content-in">
      <header className="px-4 pt-6 pb-2">
        <h1 className="text-xl font-semibold">Continue</h1>
        <p className="text-sm text-zinc-500">Pick up where you left off.</p>
      </header>

      {!link ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">Plex isn&apos;t linked</h2>
          <p className="max-w-xs text-zinc-500">
            In-progress items come from your Plex watch state — link your Plex account in Settings
            first.
          </p>
          <Link href="/settings" className="tap-target rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground">
            Go to Settings
          </Link>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">Nothing in progress</h2>
          <p className="max-w-xs text-zinc-500">
            Nothing&apos;s partway watched right now — or your sync is out of date.
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
              meta={item.percent !== null ? `${item.percent}% watched` : "In progress"}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
