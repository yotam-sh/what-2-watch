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
    // Full-bleed dark backdrop, one centred card — modelled on Overseerr's
    // login screen. Deliberately not theme-aware (no dark: variants): this
    // is the one screen in the app that always looks like this, regardless
    // of system light/dark preference, same as Overseerr's own login.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 py-12">
        <PlexSignInCard />
      </main>
    );
  }

  return <DecideScreen username={user.username} />;
}
