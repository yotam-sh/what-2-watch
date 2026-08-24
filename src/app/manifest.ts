// Next.js metadata-route convention: this file is automatically served at
// /manifest.webmanifest and Next automatically injects the corresponding
// <link rel="manifest"> tag into <head> — no manual wiring needed in
// layout.tsx. Reference shape: stark-agent/.assets/site.webmanifest, adapted
// for `display: "standalone"` (installable app, not just "add to home
// screen" bookmark) per the plan.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "what-to-watch",
    short_name: "WatchWhat",
    description: "Pulls your Plex + Letterboxd history and picks tonight's movie or show.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0f",
    theme_color: "#4f46e5",
    orientation: "portrait-primary",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
