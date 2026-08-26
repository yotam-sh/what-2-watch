// /continue — in-progress items (viewOffset set, viewCount 0 — see
// isInProgress() in src/lib/plex/library.ts). Server Component reading
// plex_items directly, same rationale as /rewatch and /watchlist.
import { eq } from "drizzle-orm";
import Link from "next/link";
import { CirclePlay, Link2Off } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { plexItems, plexLinks, titles } from "@/db/schema";
import { SyncButton } from "@/components/SyncButton";
import { TitleRow } from "@/components/TitleRow";
import { buttonClasses } from "@/components/ui/Button";
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
      <header className="px-4 pt-6 pb-3">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Continue</h1>
        <p className="text-[13px] text-secondary">Pick up where you left off.</p>
      </header>

      {!link ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <Link2Off className="h-[22px] w-[22px] text-muted" strokeWidth={2} aria-hidden="true" />
          <h2 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">
            Plex isn&apos;t linked
          </h2>
          <p className="max-w-xs text-[13px] text-secondary">
            In-progress items come from your Plex watch state — link your Plex account in Settings
            first.
          </p>
          <Link href="/settings" className={buttonClasses({ variant: "primary" })}>
            Go to Settings
          </Link>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
          <CirclePlay className="h-[22px] w-[22px] text-muted" strokeWidth={2} aria-hidden="true" />
          <h2 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">
            Nothing in progress
          </h2>
          <p className="max-w-xs text-[13px] text-secondary">
            Nothing&apos;s partway watched right now — or your sync is out of date.
          </p>
          <SyncButton endpoints={["/api/plex/sync"]} />
        </div>
      ) : (
        <ul>
          {list.map((item) => (
            <TitleRow
              key={titleKey(item)}
              title={item.title}
              year={item.year}
              runtime={item.runtime}
              posterPath={item.posterPath}
              meta={item.percent !== null ? `${item.percent}% watched` : "In progress"}
              percent={item.percent}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
