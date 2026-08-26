// Next.js metadata-route convention: this file is automatically served at
// /manifest.webmanifest and Next automatically injects the corresponding
// <link rel="manifest"> tag into <head> — no manual wiring needed in
// layout.tsx. Reference shape: stark-agent/.assets/site.webmanifest, adapted
// for `display: "standalone"` (installable app, not just "add to home
// screen" bookmark) per the plan.
//
// The two colours below are literal hex rather than CSS vars because the
// browser parses this manifest before any stylesheet exists. They mirror
// src/styles/comet/tokens.css — the one place a brand colour is defined —
// and must be kept in step with layout.tsx's `viewport.themeColor`:
//   background_color #100d16 = --comet-ink-0 (the sunken void behind the
//                              splash screen)
//   theme_color      #15111d = --comet-ink-1 (the app surface `body` paints;
//                              a violet status bar would fight the chrome)
import type { MetadataRoute } from "next";

// The PNGs below are exported from the brand masters in src/app/assets —
// direction "the pick": three posters, the chosen one lit and carrying a
// play glyph, with a coral spark above it. Edit the SVGs there and re-export
// into public/icons; never hand-edit a PNG. src/app/assets/README.md
// documents the palette (every value a Comet token), the minimum size for
// each mark variant, and the clear-space rule.
//
// Installed PWAs pick the new artwork up on their own: /icons/* is
// cache-first inside SHELL_CACHE, whose name carries the per-deploy
// BUILD_TAG (src/app/sw.js/route.ts), so a deploy rotates the cache and
// drops the old mark with it. No manual cache-clear needed.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "what2watch",
    short_name: "what2watch",
    description: "Pulls your Plex + Letterboxd history and picks tonight's movie or show.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#100d16",
    theme_color: "#15111d",
    orientation: "portrait-primary",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
