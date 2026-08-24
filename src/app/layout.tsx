import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppChrome } from "@/components/AppChrome";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import { getOptionalUser } from "@/lib/auth/guards";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "what-to-watch",
  description: "Pulls your Plex + Letterboxd history and picks tonight's movie or show.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "WatchWhat",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// theme-color/color-scheme live under `viewport`, not `metadata`, as of
// recent Next.js versions — matches manifest.ts's theme_color/background_color.
export const viewport: Viewport = {
  themeColor: "#4f46e5",
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // lets safe-area-inset-* resolve on notched devices
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getOptionalUser();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <RegisterServiceWorker />
        <AppChrome hasUser={!!user}>{children}</AppChrome>
      </body>
    </html>
  );
}
