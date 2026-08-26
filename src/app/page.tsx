// Root route: the signed-out landing page, or the Decide screen (the
// headline feature) for a signed-in user. Kept as one page.tsx rather than
// split across a route group, since both variants resolve to "/" and Next
// won't allow two page.tsx files claiming the same route. Signed-in users
// hitting this route land straight in the app — there's no separate
// "already logged in, redirect me" step, just a different branch of the
// same getOptionalUser() check the rest of the app already uses.
import { DecideScreen } from "@/components/DecideScreen";
import { PlexSignInCard } from "@/components/PlexSignInCard";
import { getOptionalUser } from "@/lib/auth/guards";

export default async function Home() {
  const user = await getOptionalUser();

  if (!user) {
    // Full-bleed sunken void with the aurora wash behind it, one centred
    // card — modelled on Overseerr's login screen. Not theme-aware, because
    // nothing in this app is: Comet is dark-only, one palette, no
    // prefers-color-scheme branch anywhere.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
        <div className="aurora aurora-void" aria-hidden="true" />
        <PlexSignInCard />
      </main>
    );
  }

  return <DecideScreen username={user.username} />;
}
