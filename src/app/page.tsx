// Root route: the signed-out landing page, or the Decide screen (the
// headline feature) for a signed-in user. Kept as one page.tsx rather than
// split across a route group, since both variants resolve to "/" and Next
// won't allow two page.tsx files claiming the same route.
import Link from "next/link";
import { DecideScreen } from "@/components/DecideScreen";
import { getOptionalUser } from "@/lib/auth/guards";

export default async function Home() {
  const user = await getOptionalUser();

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12 text-center">
        <h1 className="text-3xl font-semibold mb-2">what-to-watch</h1>
        <p className="text-zinc-500 mb-8 max-w-sm">
          Pulls your Plex and Letterboxd history and picks tonight&apos;s movie or show — so you
          stop scrolling and start watching.
        </p>
        <div className="flex gap-4">
          <Link
            href="/login"
            className="tap-target rounded-md border border-zinc-300 px-4 py-2.5 font-medium dark:border-zinc-700"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="tap-target rounded-md bg-brand px-4 py-2.5 font-medium text-brand-foreground"
          >
            Sign up
          </Link>
        </div>
      </main>
    );
  }

  return <DecideScreen username={user.username} />;
}
