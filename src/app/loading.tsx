// Instant Suspense fallback for "/" (the Decide screen — the tab most
// often tapped, since it's the app's headline feature). page.tsx here is a
// Server Component too: it calls getOptionalUser() (a DB lookup) before it
// can decide whether to render the signed-out PlexSignInCard or the
// signed-in <DecideScreen username=.../>, and DecideScreen needs that
// username as a prop, so nothing can paint until that query resolves.
//
// This mirrors DecideScreen's "results" layout — header, ModeSelector's
// pill row, FilterButton, and the poster card — since that's the state a
// returning, already-linked user lands on most often. Real user text
// (greeting, title, filter/why-tag content) isn't known yet, so those
// become skeleton bars sized to the real elements' rendered dimensions;
// once DecideScreen mounts, it hands off to its own client-side loading
// state for the roll itself (unchanged — that's a client-side fetch, not
// the Server Component blocking this fix targets).
import { SkeletonBar } from "@/components/SkeletonBar";

export default function DecideLoading() {
  return (
    <main className="flex min-h-screen-dvh flex-col">
      <header className="px-4 pt-6">
        <SkeletonBar className="h-4 w-48" />
      </header>

      <div className="flex gap-2 px-4 pb-1 pt-3">
        <SkeletonBar className="h-11 w-20 rounded-full" />
        <SkeletonBar className="h-11 w-24 rounded-full" />
        <SkeletonBar className="h-11 w-20 rounded-full" />
      </div>

      <div className="px-4 pb-2">
        <SkeletonBar className="h-11 w-24 rounded-full" />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4">
        <div className="aspect-[2/3] w-full max-w-xs overflow-hidden rounded-xl bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />

        <div className="flex flex-col items-center gap-2">
          <SkeletonBar className="h-6 w-48" />
          <SkeletonBar className="h-4 w-16" />
        </div>

        <div className="flex justify-center gap-1.5">
          <SkeletonBar className="h-6 w-14 rounded-full" />
          <SkeletonBar className="h-6 w-16 rounded-full" />
          <SkeletonBar className="h-6 w-12 rounded-full" />
        </div>

        <div className="mt-1 flex w-full max-w-xs items-center justify-between gap-2">
          <SkeletonBar className="h-11 flex-1 rounded-md" />
          <SkeletonBar className="h-11 flex-1 rounded-md" />
        </div>
        <SkeletonBar className="h-12 w-full max-w-xs rounded-md" />
      </div>
    </main>
  );
}
