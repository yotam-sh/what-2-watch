"use client";

// Wraps every page with the bottom nav, shown only for signed-in users.
// There's no separate /login or /signup route any more (see page.tsx) — the
// landing page and the Decide screen are both "/", and `hasUser` already
// distinguishes them, so the only route that still needs chrome suppressed
// on its own is /offline. `hasUser` comes from the root layout's server
// component, which already resolves the session via getOptionalUser() — no
// second client-side auth check needed here.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";

const CHROME_LESS_ROUTES = ["/offline"];

export function AppChrome({ hasUser, children }: { hasUser: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const showNav = hasUser && !CHROME_LESS_ROUTES.includes(pathname);

  return (
    <>
      {/* pt-safe is the mirror of pb-nav: installed as a PWA the web view
          runs edge to edge under the status bar (black-translucent +
          viewport-fit=cover), so without this the header sits under the
          notch and the page grows taller than the usable area. Zero in a
          browser tab. */}
      <div className={showNav ? "pb-nav pt-safe" : "pt-safe"}>{children}</div>
      {showNav && <BottomNav />}
    </>
  );
}
