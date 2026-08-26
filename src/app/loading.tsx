// Instant Suspense fallback for "/" (the Decide screen — the tab most
// often tapped, since it's the app's headline feature). page.tsx here is a
// Server Component too: it calls getOptionalUser() (a DB lookup) before it
// can decide whether to render the signed-out PlexSignInCard or the
// signed-in <DecideScreen username=.../>, and DecideScreen needs that
// username as a prop, so nothing can paint until that query resolves.
//
// Mirrors DecideScreen's "results" layout exactly, including its phone
// geometry: the same h-app-screen/overflow-hidden shell (this screen never
// scrolls on a phone), the same one-row mode+filter strip, and the same
// height-driven poster that shrinks rather than pushing the title off the
// bottom. Real user text (greeting, title, filter/why-tag content) isn't
// known yet, so those become skeleton bars sized to the real elements'
// rendered dimensions; once DecideScreen mounts, it hands off to its own
// client-side loading state for the roll itself (unchanged — that's a
// client-side fetch, not the Server Component blocking this fix targets).
//
// The verdict buttons have no placeholder because they have no visible
// counterpart on a phone: the swipe gestures are the interface there, and
// the real buttons are sr-only until focused.
import { Skeleton } from "@/components/ui/Skeleton";

export default function DecideLoading() {
  return (
    <main className="flex h-app-screen flex-col overflow-hidden sm:h-auto sm:min-h-screen-dvh sm:overflow-visible">
      <header className="flex shrink-0 items-start justify-between gap-3 px-4 pt-4 sm:pt-6">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-[11px] w-16" />
          <Skeleton className="mt-2 h-[18px] w-56 max-w-full" />
        </div>
        <Skeleton className="h-5 w-28 shrink-0" />
      </header>

      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
        <Skeleton className="h-11 flex-1 rounded-full" />
        <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 pb-2">
        <div className="flex min-h-0 w-full flex-1 items-center justify-center">
          <Skeleton className="aspect-[2/3] h-full max-h-[450px] max-w-[300px] rounded-[16px]" />
        </div>

        <div className="flex shrink-0 flex-col items-center gap-2">
          <Skeleton className="h-6 w-52 max-w-full" />
          <Skeleton className="h-3 w-16" />
        </div>

        <div className="flex shrink-0 justify-center gap-1.5">
          <Skeleton className="h-6 w-14 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-12 rounded-full" />
        </div>

        <Skeleton className="h-3 w-56 max-w-full shrink-0" />
      </div>
    </main>
  );
}
