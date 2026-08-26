// Instant Suspense fallback for /settings. SettingsPage is a Server
// Component that calls requireUser() — a session-cookie verification plus a
// DB lookup — before it can render anything at all (it needs user.username
// as a prop for both LogoutButton's sibling layout and SettingsScreen), so
// without this the tab tap leaves the previous screen on-screen until that
// resolves.
//
// Mirrors SettingsPage + SettingsScreen's structure: the "Settings" title is
// static text (copied verbatim), but the "Signed in as {username}" subtitle
// and the log-out button both need real user data, so those become
// skeleton bars sized to the real elements' rendered dimensions. The three
// cards below (Plex / Letterboxd / Danger zone) mirror SettingsScreen.tsx's
// card markup (same radius, border, padding, gap) with header + body-line +
// action-button placeholders, so nothing shifts when the real sections
// mount.
import { Skeleton } from "@/components/ui/Skeleton";

function SkeletonCard({ danger = false }: { danger?: boolean }) {
  return (
    <section
      className={`rounded-[12px] border bg-card shadow-comet-md ${danger ? "border-negative/40" : "border-line"}`}
    >
      <div className="border-b border-line-soft px-5 py-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-3 w-48 max-w-full" />
      </div>
      <div className="flex flex-col gap-3 px-5 py-5">
        <Skeleton className="h-3 w-56 max-w-full" />
        <Skeleton className="h-11 w-28 rounded-[10px]" />
      </div>
    </section>
  );
}

export default function SettingsLoading() {
  return (
    <div className="relative">
      <div className="absolute right-4 top-6">
        <Skeleton className="h-11 w-24 rounded-[10px]" />
      </div>

      <main className="min-h-screen-dvh pb-6">
        <header className="px-4 pt-6 pb-3">
          <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">Settings</h1>
          <Skeleton className="mt-1.5 h-4 w-40" />
        </header>

        <div className="flex flex-col gap-4 px-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard danger />
        </div>
      </main>
    </div>
  );
}
