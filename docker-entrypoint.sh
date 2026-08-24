#!/bin/sh
# ---------------------------------------------------------------------------
# Runtime entrypoint. Migrations must complete before the server starts, and
# a failed migration must fail the container loudly (non-zero exit, no
# server started) rather than silently boot a server against a stale/broken
# schema — `set -e` plus running migrate as a distinct step before `exec`
# gives us both.
#
# migrate.ts (src/db/migrate.ts) is not part of the Next.js request path, so
# nothing traces or compiles it into .next/standalone. It's run here exactly
# like `npm run db:migrate` does locally: via tsx, which transpiles TS
# on-the-fly and resolves the "@/*" path alias from tsconfig.json. Only tsx
# + esbuild (tsx's one real dependency) and the small set of files migrate.ts
# actually imports are present in this image — see Dockerfile.
# ---------------------------------------------------------------------------
set -e

echo "[entrypoint] applying database migrations..."
node ./node_modules/tsx/dist/cli.mjs ./src/db/migrate.ts

echo "[entrypoint] starting server..."
exec node server.js
