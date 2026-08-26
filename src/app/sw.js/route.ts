// GET /sw.js — the service worker script, served from a Route Handler
// rather than a static public/sw.js file so the cache-busting build tag can
// be computed at server-start time (see BUILD_TAG below) instead of being
// hand-maintained. A folder named "sw.js" containing a route.ts is the same
// documented Next.js pattern used for app/robots.txt or app/sitemap.xml when
// the built-in metadata-file API isn't expressive enough — it maps directly
// to the /sw.js URL, which matters because a service worker's default scope
// is the directory of the script that registers it ("/" here).
//
// CACHE-BUSTING / "a new deploy invalidates the old shell": BUILD_TAG is
// computed once when this module first loads, i.e. once per server process.
// Every deploy replaces the running process, so every deploy gets a fresh
// tag, which changes SHELL_CACHE's name, which makes the SW's activate
// handler below delete every previously-cached shell. Posters live in a
// separately-named, non-versioned cache (content-addressed by TMDB's
// immutable poster path, so there is nothing to bust) and survive a shell
// cache rotation on purpose.
//
// PRIVACY: nothing under /api/ is ever cached — see shouldBypass() below.
// This app holds other people's Plex/Letterboxd history behind per-user
// auth; a stale or cross-user cache hit on an API response would be a
// privacy bug, not a UX glitch, so API requests always go straight to the
// network with no cache read or write.
const BUILD_TAG = String(Date.now());

const SCRIPT = `
const BUILD_TAG = ${JSON.stringify(BUILD_TAG)};
const SHELL_CACHE = "wtw-shell-" + BUILD_TAG;
const POSTER_CACHE = "wtw-posters-v1";
const OFFLINE_URL = "/offline";
const CURRENT_CACHES = [SHELL_CACHE, POSTER_CACHE];

// Same-origin static asset prefixes safe to cache-first: content-hashed
// Next.js build output, icons, and the manifest never change shape without
// changing URL.
// "/favicon.ico" is deliberately absent: there is no app/favicon.ico any
// more. The brand set (src/app/assets) ships favicon.svg + 32/16px PNGs,
// declared explicitly in layout.tsx's metadata.icons, and all of those live
// under the /icons/ prefix below. Next's app/favicon.ico convention
// auto-injects its own <link rel="icon"> that would have outranked those
// declarations and kept serving the old indigo mark.
const STATIC_PREFIXES = ["/_next/static/", "/icons/"];
const STATIC_EXACT = ["/manifest.webmanifest"];

// TMDB's poster CDN — the only cross-origin host this SW ever caches.
// Poster paths are immutable once TMDB assigns them, so cache-first is safe
// and never goes stale.
const POSTER_HOST = "image.tmdb.org";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort: an offline install (e.g. flaky network on first visit)
      // must not fail the whole SW registration.
      try {
        await cache.add(OFFLINE_URL);
      } catch {
        // ignore — offline fallback just won't be pre-warmed this time.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("wtw-") && !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/api/");
}

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (STATIC_EXACT.includes(url.pathname)) return true;
  return STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isPosterRequest(url) {
  return url.hostname === POSTER_HOST;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Cache successful same-origin responses and cross-origin "opaque"
  // responses alike (a no-cors cross-origin fetch always reports status 0 /
  // type "opaque" even on success — that's expected for the poster CDN, not
  // an error).
  if (response && (response.ok || response.type === "opaque")) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw new Error("offline and no cached fallback available");
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // never intercept mutating requests

  const url = new URL(request.url);

  // Never cache anything user-specific or session-dependent. Straight to the
  // network, every time.
  if (isApiRequest(url)) return;

  if (isPosterRequest(url)) {
    event.respondWith(cacheFirst(request, POSTER_CACHE));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // Everything else (other same-origin GETs, other cross-origin calls):
  // default browser behavior, not intercepted.
});
`;

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // The SW script itself must never be cached long-term, or a stuck
      // browser would keep re-installing the OLD worker forever — the exact
      // "permanently stuck cached app" failure mode this file's header talks
      // about avoiding downstream.
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}
