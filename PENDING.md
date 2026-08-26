# Pending work

Known gaps, roughly in priority order. Items are here because they were
consciously deferred, not because they were missed — each says why.

## Next up

- **Pagination for `fetchWatchlist`** (`src/lib/plex/discover.ts`)
  The Plex Discover watchlist fetch does not paginate, so a large watchlist is
  silently truncated. Not the cause of any observed bug — a truncation would
  not have produced the `watchlistSynced: 0 / watchlistUnresolved: 0` seen in
  testing — but it is a real ceiling waiting for whoever first has a big
  watchlist.

- **Lighthouse run against the live HTTPS deploy**
  Never actually executed. The attempt during Phase 4 failed on a Windows
  sandbox permission error in `chrome-launcher`, and the PWA criteria were
  verified by hand instead (manifest fields, icon sizes, SW registration and
  scope, offline fallback, no console errors). The service worker only behaves
  authentically over HTTPS, so the deployed instance is the only honest place
  to measure this.

## Known limitations

- **Multi-server sync ships wired, but sequentially**
  `syncJob` loops `syncLibraries()` once per selected server rather than
  running them concurrently — deliberate, to avoid N simultaneous full scans
  against a NAS-hosted PMS. A selected-but-unreachable server is skipped and
  reported via `serversUnreachable` instead of failing the whole sync. Two
  large libraries therefore take roughly twice as long as one.

- **Full-library scan holds a section in memory**
  `scanAndResolve` materialises one library section before returning.
  Comfortable to roughly 20–30k items; beyond that it wants streaming. The
  container currently runs with no memory limit (`MemLimit=0`), so this is
  bounded by NAS RAM rather than by cgroup.

- **Jobs are lost on container restart**
  The sync job registry and the post-sync enrichment pass are both in-memory
  by design — no jobs table, no retry queue. `sync_state` keeps the durable
  record of the last outcome. A restart mid-sync means re-running it.

- **CF and LTR are gated off until data exists**
  `CF_MIN_USERS = 5` + `CF_MIN_POSITIVE_SIGNALS = 200`; `LTR_MIN_LABELED_INTERACTIONS = 30`.
  Working as designed — a model trained on nothing is worse than content-based
  scoring. Real usage is what switches them on.

- **`linux/arm64` image is not built**
  CI targets `linux/amd64` only. Three native modules under QEMU emulation is
  where multi-arch gets flaky rather than merely slow. Only matters if the
  deployment target stops being x86.

- **Embedding yields rather than forking**
  `backfillEmbeddings` yields to the event loop between items, measured at
  3.6–5.9ms per inference locally. If the NAS falls back to the WASM ONNX
  backend instead of native `onnxruntime-node`, per-inference latency could be
  high enough that a forked worker becomes necessary. Symptom would be the app
  going sluggish while enrichment runs.

## Deferred by choice

- **App icon artwork**
  The Comet re-skin landed, but `public/icons/*.png` (192, 512, maskable,
  apple-touch) still carry the old indigo `#4f46e5` mark. Names, sizes and
  manifest wiring are already correct — only the pixels are stale. They need
  regenerating against `--comet-violet-400` (`#a382f7`) and the comet mark in
  `src/components/ui/Wordmark.tsx`. Tracked as `TODO(artwork)` in
  `src/app/manifest.ts`.

- **LLM mood parser / re-ranker**
  Offered during planning and declined for v1: natural-language mood input
  ("something funny but not stupid, under 100 minutes") parsed into structured
  filters, with a model re-ranking the shortlist and giving a one-line reason.
  The `interactions` table is already the right shape to evaluate it against.

- **Letterboxd CSV import**
  The only ToS-clean route to a Letterboxd *watchlist* and to full pre-RSS
  history. RSS covers the diary (50 most recent entries) and carries TMDB ids;
  the Plex Discover watchlist covers the watchlist need for now.

- **Trakt integration**
  A third OAuth and a third token to protect. Only worth it if Plex and
  Letterboxd together leave a real gap.
