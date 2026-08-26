# what2watch — brand assets

Direction **1d "The pick"**: three posters, the chosen one lit and carrying a play
glyph, with a coral spark above it. It reads as *decide*, not just *watch*, and the
icon is a miniature of the app's own Decide screen.

Built on the Comet design system. Every value below is a Comet token — nothing here
introduces a colour outside the system.

| Role | Token | Hex |
|---|---|---|
| Chosen poster (gradient, bottom → top) | `--comet-violet-700` → `--comet-violet-300` | `#7338e8` → `#b9a3fb` |
| Unchosen posters | `--comet-ink-5` | `#3a3050` |
| Play glyph | `--comet-text-0` | `#f2edf8` |
| Spark | `--comet-glow-400` | `#ff9d6b` |
| Icon background | `--comet-ink-1` + `--grad-aurora` | `#15111d` |

## Contents

### `svg/` — masters, edit these
| File | Use |
|---|---|
| `mark.svg` | Primary mark, 48px and up. Play glyph sits in a translucent scrim disc. |
| `mark-compact.svg` | Small-size mark, 20–48px. Wider posters, play punched straight out of the poster, no scrim, no spark. |
| `mark-mono.svg` | Single colour via `currentColor` — inherits text colour. For monochrome contexts and print. |
| `favicon.svg` | Tab-size mark. Widest posters, largest play punch. |
| `icon-tile.svg` | 512 app tile: aurora background, 22.5% corner radius, mark at 62%. |
| `icon-tile-bleed.svg` | 512 full-bleed tile for maskable/apple-touch. Mark at 52% so it clears any mask shape. |
| `lockup-horizontal.svg` | Mark + wordmark on one line. |
| `lockup-stacked.svg` | Mark above wordmark, centred. |

### `png/` — ready to drop in `public/icons/`
`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon-180.png`,
`favicon-32.png`, `favicon-16.png`.

## Wiring it into the app

`src/app/manifest.ts`:

```ts
name: "what2watch",
short_name: "what2watch",
background_color: "#100d16",
theme_color: "#15111d",
icons: [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
],
```

`src/app/layout.tsx` — `theme_color` and `viewport.themeColor` must agree, or the
status bar flashes a different colour on launch:

```ts
export const viewport: Viewport = { themeColor: "#15111d", colorScheme: "dark" };
export const metadata: Metadata = {
  title: "what2watch",
  appleWebApp: { capable: true, title: "what2watch", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/favicon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180" }],
  },
};
```

## Usage rules

- **Clear space** on all sides is 25% of the mark's height. Nothing crosses it.
- **Minimum sizes:** `mark.svg` down to 48px, `mark-compact.svg` 20–48px,
  `favicon.svg` below 20px. Below 16px, drop the mark and use the wordmark alone.
- **Backgrounds:** the mark is built for `--comet-ink-0`/`--comet-ink-1`. On any other
  surface, or anywhere the violet can't go, use `mark-mono.svg`.
- **The wordmark is always lowercase** — `what2watch`, one word, the `2` in
  `--accent` (`#a382f7`). Never `What2Watch`, `WatchWhat`, or `what-to-watch`.
- **Don't** recolour the posters, add a stroke or outer glow, rotate the mark, place it
  on a photo, or stretch either lockup non-uniformly.

## Two things to know

1. **The lockup SVGs reference Bricolage Grotesque by name.** They render correctly
   wherever that font is available (it's the app's display face, loaded via
   `next/font/google`). For anywhere else — a README image, a third-party site, an
   email — convert the `<text>` to outlines first.
2. **The `png/` files replace the old indigo icons** in `public/icons/`. Overwrite them
   in place, keep the filenames the manifest already points at where they match, and
   clear the service-worker cache on the first deploy or installed PWAs will keep
   showing the old mark.
