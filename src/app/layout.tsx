import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { AppChrome } from "@/components/AppChrome";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import { getOptionalUser } from "@/lib/auth/guards";
import "./globals.css";

// Comet's type trio. All three are variable fonts, so `weight` is
// deliberately omitted — next/font only requires it for static families, and
// omitting it fetches the whole wght axis so CSS font-weight works normally
// across 400–700. next/font self-hosts these at build time, so there is no
// request to Google at runtime and nothing for the CSP to allow.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "what2watch",
  description: "Pulls your Plex + Letterboxd history and picks tonight's movie or show.",
  appleWebApp: {
    capable: true,
    // black-translucent, not "default": the app already paints its own dark
    // ground edge-to-edge and reserves the notch via viewportFit: "cover" +
    // env(safe-area-inset-*), so letting content run under the status bar is
    // the correct pairing. "default" draws an opaque light bar above a
    // near-black app.
    statusBarStyle: "black-translucent",
    title: "what2watch",
  },
  // Artwork masters live in src/app/assets; see its README for which mark
  // variant is legible at which size (favicon.svg is the tab-size cut, with
  // the widest posters and the largest play punch).
  icons: {
    icon: [
      { url: "/icons/favicon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

// theme-color/color-scheme live under `viewport`, not `metadata`, as of
// recent Next.js versions. #15111d is --comet-ink-1 (the app surface, i.e.
// what `body` paints) and matches manifest.ts's theme_color — a literal hex
// because the browser reads this <meta> before any stylesheet exists.
// Dark only: there is exactly one palette (src/styles/comet/tokens.css), so
// this is "dark", never "light dark".
export const viewport: Viewport = {
  themeColor: "#15111d",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // lets safe-area-inset-* resolve on notched devices
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getOptionalUser();

  return (
    <html
      lang="en"
      // color-scheme on the root element tells the UA to render its own
      // widgets (scrollbars, form controls, the overscroll gutter) dark, so
      // they don't flash white against the void.
      style={{ colorScheme: "dark" }}
      className={`${bricolage.variable} ${hanken.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-app text-body">
        <RegisterServiceWorker />
        <AppChrome hasUser={!!user}>{children}</AppChrome>
      </body>
    </html>
  );
}
