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
// sections below (Plex / Letterboxd / Danger zone) mirror
// SettingsScreen.tsx's section markup (same border/padding) with title +
// body-line + action-button placeholders, so nothing shifts when the real
// sections mount.
import { SkeletonBar } from "@/components/SkeletonBar";

function SkeletonSection({ danger = false }: { danger?: boolean }) {
  return (
    <section className="border-t border-zinc-200 px-4 py-6 dark:border-zinc-800">
      <SkeletonBar className={`mb-2 h-4 w-24 ${danger ? "bg-red-100 dark:bg-red-950/50" : ""}`} />
      <SkeletonBar className="mb-3 h-3 w-56 max-w-full" />
      <SkeletonBar className="h-9 w-28 rounded-md" />
    </section>
  );
}

export default function SettingsLoading() {
  return (
    <div className="relative">
      <div className="absolute right-4 top-6">
        <SkeletonBar className="h-9 w-24 rounded-md" />
      </div>

      <main className="min-h-screen-dvh pb-6">
        <header className="px-4 pt-6 pb-2">
          <h1 className="text-xl font-semibold">Settings</h1>
          <SkeletonBar className="mt-1.5 h-4 w-40" />
        </header>

        <SkeletonSection />
        <SkeletonSection />
        <SkeletonSection danger />
      </main>
    </div>
  );
}
