"use client";

// Registers /sw.js. Deliberately skipped outside production: Turbopack's dev
// server rewrites and hot-reloads assets constantly, and a cache-first SW
// sitting in front of that would serve stale chunks and look like a broken
// build — the classic "why isn't my change showing up" dev complaint. This
// keeps `next dev` exactly as before (no registration attempt at all) while
// still exercising the real thing in `next start` / production.
//
// Update handling: once a new SW takes control (which only happens after a
// fresh deploy changes sw.js's BUILD_TAG — see src/app/sw.js/route.ts), a
// single automatic reload picks up the new shell rather than leaving the
// user on stale assets indefinitely.
import { useEffect } from "react";

export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Never let SW registration failure break the app — this is
      // progressive enhancement, not a requirement to render.
      // eslint-disable-next-line no-console
      console.error("Service worker registration failed", err);
    });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
