# syntax=docker/dockerfile:1
#
# Multi-stage build: deps -> build -> runtime.
#
# The hard constraint driving this file: better-sqlite3 (an npm alias for
# better-sqlite3-multiple-ciphers, the SQLCipher-enabled fork — see
# package.json) is a NATIVE addon. Its compiled .node binary is
# platform-specific, so it is installed/compiled INSIDE this (Linux) image,
# never copied from the Windows host. next.config.ts also marks
# "better-sqlite3-multiple-ciphers" as a serverExternalPackage so Next's
# bundler leaves it alone — which means the standalone output's own tracing
# is the only thing that would normally get it into the runtime stage, and
# that tracing is verified explicitly below rather than trusted.

# ---------------------------------------------------------------------------
# Stage 1: deps — install all dependencies (including devDependencies)
# inside a Linux container.
#
# python3/make/g++ cover the node-gyp fallback if no prebuilt binary matches
# this platform/Node ABI for better-sqlite3-multiple-ciphers. This is the
# ONLY stage that carries build tooling — it never reaches the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# node:22-slim bundles npm 10.9.8, which has a lockfileVersion-3 bug reading
# this repo's lock: it misreads nested optionalDependencies (tsx pins its
# own esbuild ~0.28.0, separate from the top-level esbuild ~0.25.x another
# package needs) and refuses with "Missing: esbuild@0.28.2 from lock file"
# even though the nested entries are present and `npm ci` is clean on npm
# 11+. Upgrading npm before `npm ci` avoids depending on a lockfile
# structure workaround.
RUN npm install -g npm@11
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2: build — `next build` with output: "standalone" (see
# next.config.ts). devDependencies are required here: notably `typescript`
# and the ambient type shim at src/types/better-sqlite3-multiple-ciphers.d.ts,
# which exists specifically because that package's `exports` map has no
# `types` condition — `next build`'s type-check step fails without it.
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules

# Bake the ML embedding model into the image (Phase 5, src/lib/ml/embed.ts).
# That module is explicit that production must NEVER fetch model weights at
# request time — a home NAS may have flaky or no connectivity, and the model
# is only ever loaded from a local directory (`resolveModelDir()`) once
# NODE_ENV=production, allowRemoteModels=false. This step is what has to
# populate that directory ahead of time.
#
# Uses transformers.js's own hub-download/cache machinery rather than
# hand-built URLs, pointed at the same directory embed.ts's localModelPath
# will later read from purely locally: FileCache.put() writes each fetched
# file to `path.join(env.cacheDir, "<repoId>/<filename>")`, which is
# byte-for-byte the same relative layout `path.join(localModelPath,
# "<repoId>/<filename>")` looks up — so whatever this call downloads is
# exactly what the runtime lookup will find, using the identical `dtype:
# "q8"` quantization embed.ts requests. Needs network access at build time
# only (this stage, same as `npm ci`) — never at container runtime.
RUN mkdir -p /app/models && node -e "\
(async () => { \
  const { pipeline, env } = await import('@huggingface/transformers'); \
  env.cacheDir = '/app/models'; \
  env.allowRemoteModels = true; \
  await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' }); \
  console.log('[docker build] embedding model cached at /app/models'); \
})().catch((err) => { console.error(err); process.exit(1); });"

COPY . .
# `next build`'s "Collecting page data" step imports route modules (to read
# their runtime config), which transitively imports src/lib/env.ts — whose
# fail-fast validation (by design, see src/lib/env.ts) calls
# process.exit(1) if these are unset. The real values are never known at
# build time and aren't needed then; these are syntactically-valid
# placeholders that satisfy validation only, scoped to this discarded build
# stage — they are NOT copied into the runtime stage and do not appear in
# the final image. Real values are injected at container start via
# `env_file`/orchestrator secrets (see docker-compose.yml, README.md).
ENV SERVER_ENCRYPTION_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
    JWT_SECRET="build-time-placeholder-not-a-real-secret-000" \
    TMDB_API_KEY="build-time-placeholder"
# "Collecting page data" imports every route module (including this one's
# module-scope `new Database(...)` in src/db/client.ts) across 11 parallel
# workers, all pointed at the same not-yet-existing ./data/app.db — a
# straight create race where the loser sees a half-initialized file and
# reports "the encryption key was rejected" (SQLCipher's generic
# corrupt-or-wrong-key message). Running the real migration once, serially,
# first means every worker opens an already-valid file instead of racing to
# create one. This throwaway build-stage DB (keyed with the placeholder
# above) never leaves this stage — the runtime stage does not COPY ./data.
RUN node ./node_modules/tsx/dist/cli.mjs ./src/db/migrate.ts
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: runtime — node:22-slim, non-root, minimal surface.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid appuser --shell /usr/sbin/nologin --no-create-home appuser

# Next's standalone output: server.js + a traced/pruned node_modules.
COPY --from=build --chown=appuser:appuser /app/.next/standalone ./
COPY --from=build --chown=appuser:appuser /app/.next/static ./.next/static
COPY --from=build --chown=appuser:appuser /app/public ./public

# Belt-and-suspenders for the native module: it's imported both directly as
# "better-sqlite3-multiple-ciphers" (src/db/client.ts) and, via the npm
# alias in package.json, as "better-sqlite3" (drizzle-orm's better-sqlite3
# driver requires that literal package name). Next's file tracer (@vercel/nft)
# is supposed to follow serverExternalPackages into .next/standalone/node_modules
# on its own, but tracing a native .node binary resolved via a computed path
# at require-time is exactly the kind of thing nft can silently miss — so
# both package directories are copied explicitly from the full `build`
# install rather than trusted to tracing. This was verified by running the
# built image; see the deploy notes in README.md.
COPY --from=build --chown=appuser:appuser /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build --chown=appuser:appuser /app/node_modules/better-sqlite3-multiple-ciphers ./node_modules/better-sqlite3-multiple-ciphers

# Same reasoning, same fix, for the ML stack's native modules: onnxruntime-node
# (the inference engine @huggingface/transformers' Node backend uses) and
# sharp (its image-preprocessing dependency) both ship prebuilt native
# binaries and are both in Next's own default serverExternalPackages list —
# meaning they're excluded from bundling the same way better-sqlite3 is, and
# are subject to the exact same "did tracing actually copy the binary"
# question. Copied explicitly rather than trusted. @huggingface/transformers
# itself is pure JS orchestration around those two, copied for the same
# "not actually invoked by any traced route today, but embed.ts is reachable
# from recommend.ts and contains the dynamic import" caution as drizzle-orm
# below.
COPY --from=build --chown=appuser:appuser /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=build --chown=appuser:appuser /app/node_modules/sharp ./node_modules/sharp
COPY --from=build --chown=appuser:appuser /app/node_modules/@huggingface ./node_modules/@huggingface

# The vendored model weights (see the RUN in the `build` stage above).
# ML_MODEL_DIR is set explicitly rather than relied on implicitly matching
# resolveModelDir()'s `<cwd>/models` default, so this stays correct even if
# WORKDIR ever changes.
COPY --from=build --chown=appuser:appuser /app/models ./models
ENV ML_MODEL_DIR=/app/models

# Migrations must run before the server starts (docker-entrypoint.sh).
# migrate.ts is never imported by the Next app itself, so nothing traces it
# into .next/standalone — it's run directly via tsx, the same way
# `npm run db:migrate` runs it locally. Only the files that script (and its
# imports) actually touch are copied, plus tsx + esbuild (tsx's one real
# runtime dependency).
#
# drizzle-orm and zod ARE used by the Next app (src/db/client.ts,
# src/lib/env.ts) but are *not* in serverExternalPackages, so Next bundles
# (inlines) their code straight into the compiled route chunks — verified
# by inspecting a built image: neither package exists anywhere under
# .next/standalone/node_modules even though the app imports both. That's
# fine for serving requests (the bundled copy works), but migrate.ts runs
# outside that bundle via tsx and needs the real packages on disk, so they
# are copied explicitly too. Both are pure JS (no native binary), so this
# is a plain, platform-independent copy.
COPY --from=build --chown=appuser:appuser /app/node_modules/tsx ./node_modules/tsx
COPY --from=build --chown=appuser:appuser /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=build --chown=appuser:appuser /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=build --chown=appuser:appuser /app/node_modules/zod ./node_modules/zod
COPY --from=build --chown=appuser:appuser /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=appuser:appuser /app/src/db ./src/db
COPY --from=build --chown=appuser:appuser /app/src/lib/env.ts ./src/lib/env.ts

# ---------------------------------------------------------------------------
# TMDB and embedding backfill CLIs (src/lib/tmdb/runBackfill.ts,
# src/lib/ml/runBackfill.ts — see README.md "Bulk backfill" for the exact
# `docker compose exec` invocations). Same situation as migrate.ts above:
# neither is imported by the Next app, so nothing traces them into
# .next/standalone — they're run directly via tsx and need their own files
# plus every real on-disk dependency they import, copied in explicitly.
#
# Source: the whole src/lib/tmdb and src/lib/ml directories, not just the
# two runBackfill.ts entrypoints — runBackfill.ts -> backfill.ts -> store.ts
# -> client.ts/mapper.ts for TMDB; runBackfill.ts -> embedBackfill.ts ->
# embed.ts for ML. Test files ride along uncopied-for (same as
# src/db/schema.test.ts above) — nothing at runtime ever imports a
# *.test.ts file, so their presence is inert.
#
# Dependencies — the tsx/esbuild/drizzle-orm/zod/better-sqlite3* copies
# above already cover everything the TMDB CLI needs (backfill.ts/store.ts/
# client.ts pull in nothing beyond those + src/lib/env.ts, already copied).
# The ML CLI is the hard case the file header above warns about: tsx does
# not bundle, so every module @huggingface/transformers' NODE backend
# actually `require()`s at load time must be resolvable on disk — not just
# the packages already copied for the Next app's own (bundled, nft-traced)
# use of it. Traced by reading
# node_modules/@huggingface/transformers/dist/transformers.node.mjs — the
# file Node's "node" export condition resolves to, distinct from the
# browser bundle tsx would never touch — rather than assumed:
#   - `import * as ONNX_NODE from "onnxruntime-node"` — already copied above.
#   - `import { Tensor } from "onnxruntime-common"` — onnxruntime-node's own
#     dependency, hoisted by npm to a TOP-LEVEL node_modules/onnxruntime-common
#     rather than nested under onnxruntime-node/node_modules, so it needs
#     its own explicit copy — NOT already covered by the onnxruntime-node
#     copy above.
#   - `import sharp from "sharp"` — already copied above, but sharp's own
#     dist/libvips.cjs (loaded from sharp's main entry point) additionally
#     `require()`s `semver`, `detect-libc`, `@img/colour`, and the
#     platform-specific native packages `@img/sharp-libvips-<platform>` +
#     `@img/sharp-<platform>-<arch>` — none of which the plain `sharp`
#     directory copy above includes. Copying the whole `@img` scope (same
#     approach as `@huggingface` above) picks up exactly whichever platform
#     variant npm actually installed for this image's architecture and
#     nothing more.
# Verified for real, not just traced: built and ran both
# `node ./node_modules/tsx/dist/cli.mjs ./src/lib/tmdb/runBackfill.ts` and
# the ml/ equivalent inside an actual container — see README.md.
# ---------------------------------------------------------------------------
COPY --from=build --chown=appuser:appuser /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=build --chown=appuser:appuser /app/node_modules/@img ./node_modules/@img
COPY --from=build --chown=appuser:appuser /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build --chown=appuser:appuser /app/node_modules/semver ./node_modules/semver
COPY --from=build --chown=appuser:appuser /app/src/lib/tmdb ./src/lib/tmdb
COPY --from=build --chown=appuser:appuser /app/src/lib/ml ./src/lib/ml

# ---------------------------------------------------------------------------
# Stats CLI (src/lib/stats/runStats.ts — `docker compose exec app npm run
# stats`). Same situation again: not imported by the Next app, so nothing
# traces it into .next/standalone.
#
# src/lib/reconcile.ts is NOT redundant with the copies above. The ML
# backfill CLI never needed it (runBackfill.ts -> embedBackfill.ts ->
# embed.ts stops short of it), but the stats script imports
# LTR_MIN_LABELED_INTERACTIONS from src/lib/ml/ltr.ts, and ltr.ts imports
# getReconciledWatchHistory from reconcile.ts. Importing the thresholds from
# the modules that define them — rather than restating the numbers here — is
# deliberate: a duplicated constant would drift silently and the report would
# start lying about how close a model is to training. The cost is this one
# extra file, traced by walking runStats.ts's imports rather than guessed.
# ---------------------------------------------------------------------------
COPY --from=build --chown=appuser:appuser /app/src/lib/reconcile.ts ./src/lib/reconcile.ts
COPY --from=build --chown=appuser:appuser /app/src/lib/stats ./src/lib/stats

COPY --chown=appuser:appuser docker-entrypoint.sh ./docker-entrypoint.sh

# `.next/standalone` is NOT clean of the build stage's throwaway database.
# Next's file tracer (@vercel/nft) records file-system access made while
# "Collecting page data" runs every route module — and the RUN above that
# pre-creates the DB (to dodge the parallel-worker create race, see above)
# means the tracer observes a real open() on ./data/app.db and copies that
# file straight into .next/standalone/data/app.db, as a traced dependency.
# Verified by building without this line and finding a baked-in app.db in
# the image. It's only ever the placeholder-keyed throwaway, never real
# data, but a database file — of any kind — belongs on the mounted volume,
# not in an image layer, so it's removed before the mount point is created.
RUN chmod +x ./docker-entrypoint.sh \
    && rm -rf ./data \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app /app/data

USER appuser

EXPOSE 3000

# Stdlib-only healthcheck — node:22-slim has no curl, and none is added just
# for this. Mirrors the pattern in spotify-tracker/Dockerfile (Python stdlib
# urllib there; Node's built-in `http` here).
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
