"use client";

// Wraps every page with the bottom nav, shown only for signed-in users and
// hidden on the auth screens (a logged-in user shouldn't normally land on
// /login or /signup, but a direct visit shouldn't show a floating nav bar
// over a login form either). `hasUser` comes from the root layout's server
// component, which already resolves the session via getOptionalUser() — no
// second client-side auth check needed here.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";

const CHROME_LESS_ROUTES = ["/login", "/signup", "/offline"];

export function AppChrome({ hasUser, children }: { hasUser: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const showNav = hasUser && !CHROME_LESS_ROUTES.includes(pathname);

  return (
    <>
      <div className={showNav ? "pb-16" : undefined}>{children}</div>
      {showNav && <BottomNav />}
    </>
  );
}
