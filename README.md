# what-to-watch

Picks tonight's movie or show from your real Plex + Letterboxd history.
See `docs`/the project plan for the full architecture. Shipped so far:
project scaffold, database schema, crypto, env validation, and
username/password auth (Phase 1); Plex sync (Phase 2); Letterboxd/TMDB sync
(Phase 3); content/CF/LTR ranking (Phase 5); and Docker + CI (Phase 6, this
document's main subject). The PWA shell (Phase 4) is not in this repo yet.

## Prerequisites

- Node.js 22+ and npm, for local dev.
- Docker, for the deploy path (see "Docker / deploy" below) — no local
  Node/npm needed if you're only running the container.
- A [TMDB](https://www.themoviedb.org/settings/api) account (free) for
  `TMDB_API_KEY`.
- For production: a domain on Cloudflare and a Cloudflare Zero Trust account
  (free tier is fine) for the Tunnel — see "Cloudflare Tunnel setup" below.

## Environment variables

`.env.example` documents every variable and how to generate it — copy it to
`.env.local` for local dev (Next.js loads that file automatically) or to
`.env` for Docker Compose (`env_file: .env`). Three are required and
validated at startup by `src/lib/env.ts`, which refuses to boot with a clear
stderr message if anything's missing or malformed rather than failing
confusingly later:

| Variable | Required | Generate with |
|---|---|---|
| `SERVER_ENCRYPTION_KEY` | yes | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `JWT_SECRET` | yes | `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `TMDB_API_KEY` | yes | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — instant, free |
| `SECURE_COOKIES` | no (default `false`) | `false` for local http dev, `true` in production (behind the Tunnel) |
| `TAUTULLI_URL` / `TAUTULLI_API_KEY` | no | only if you run Tautulli (Phase 2 optional enrichment) |
| `ML_MODEL_DIR` | no (default `<cwd>/models`) | only if you want the embedding model somewhere non-default — Docker already sets this |
| `TUNNEL_TOKEN` | Compose only | Cloudflare Zero Trust dashboard — see "Cloudflare Tunnel setup" |

`SERVER_ENCRYPTION_KEY` is the one to treat with real care: it's both the
`serverVault` AES key and the SQLCipher key for the entire database file.
See "Encryption at rest" and "Backups" below before you do anything with it
beyond generating it once.

## Local dev quickstart

```bash
npm install
cp .env.example .env.local   # then fill in SERVER_ENCRYPTION_KEY, JWT_SECRET, TMDB_API_KEY
npm run db:migrate           # creates ./data/app.db and applies migrations
npm run dev                  # http://localhost:3000
```

## Scripts

- `npm run dev` / `npm run build` / `npm run start` — standard Next.js.
- `npm run test` — Vitest (crypto, env validation, schema/migrations, ML, sync).
- `npm run db:generate` — regenerate a Drizzle migration after editing `src/db/schema.ts`.
- `npm run db:migrate` — apply pending migrations to `./data/app.db`. Also
  what `docker-entrypoint.sh` runs before starting the server in the
  container (see "Docker / deploy").
- `npm run ml:backfill` — embed any titles missing a vector (Phase 5). Needs
  the model at `ML_MODEL_DIR` (see above); downloads it there on first run
  outside Docker.
- `npm run lint` — ESLint.

## Layout

- `src/db/` — Drizzle schema (all 9 tables) + migrations. SQLite via
  `better-sqlite3-multiple-ciphers` (WAL mode), the entire file encrypted at
  rest with SQLCipher — see "Encryption at rest" below.
- `src/lib/crypto/` — AES-256-GCM helper plus two vault scopes:
  `userVault` (Argon2id-derived, per-user, session-only key — encrypts the
  Plex token) and `serverVault` (env-var key — encrypts derived data).
- `src/lib/auth/` — Argon2id password hashing, JWT sessions (`jose`), an
  in-memory vault-key session store, rate limiting, and `requireUser()` /
  `getOptionalUser()` guards.
- `src/lib/plex/`, `src/lib/letterboxd/`, `src/lib/tmdb/` — Phase 2/3 sync.
- `src/lib/ml/` — Phase 5 ranking: `embed.ts` (transformers.js embeddings),
  `cf.ts` (ALS), `ltr.ts` (learn-to-rank), `score.ts`/`recommend.ts` (the
  orchestration `/api/recommend` calls).
- `src/app/(auth)/{signup,login}` — auth pages.
- `src/app/api/health` — unauthenticated liveness check for Docker.
- `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
  `.github/workflows/publish.yml` — Phase 6, see "Docker / deploy" below.

The PWA shell (Phase 4: manifest, service worker, core screens) is the one
piece of the master plan not yet in this repo.

## Encryption at rest

The whole `./data/app.db` file is encrypted at rest via SQLCipher, using
`better-sqlite3-multiple-ciphers` (an API-compatible drop-in for
`better-sqlite3` with the SQLCipher-compatible codec built into the native
addon — see `src/db/sqlcipherKey.ts` and `src/db/client.ts`). Per-column
encryption was rejected because `tmdb_id` has to stay indexable/joinable in
plaintext for the recommender; encrypting the whole file instead means
`watch_events`, ratings, and the Letterboxd handle are covered too, not just
the Plex token (which also has its own AES-256-GCM envelope on top, via
`userVault`/`serverVault` — the SQLCipher layer doesn't replace that, it
protects everything else that layer doesn't reach).

The key is `SERVER_ENCRYPTION_KEY` (base64, 32 bytes) — the same env var
already used for the `serverVault` AES scope. It's applied via SQLCipher's
raw-key form (`PRAGMA key = "x'<64 hex chars>'"`, decoded from the base64
env var) as the very first statement on the connection, before WAL or
`foreign_keys` or anything else — SQLCipher can't tell "wrong key" from
"corrupt file" for any statement issued before it's keyed correctly.

**Losing `SERVER_ENCRYPTION_KEY` means losing the database. There is no
recovery path, by design.** A backup that includes the `.db` file but not
the key protects nothing; a backup of the key without the `.db` file is
equally useless. Back up both together, and treat the key with at least as
much care as the data it protects — if you rotate it, use the migration
procedure below first, and never regenerate it against an existing data
directory.

### Converting an existing plaintext database

The dev database this repo ships with (`./data/app.db` before you first run
`npm run db:migrate`) is disposable — just delete `data/app.db*` and
re-migrate. But a production deploy will eventually have a real plaintext
`.db` from before this change was deployed, and that one needs converting in
place rather than thrown away. SQLCipher's own `ATTACH`/`sqlcipher_export`
procedure does this without a custom script:

```sql
-- Using sqlite3mc (or any SQLite3MultipleCiphers-aware client), against the
-- OLD plaintext file:
ATTACH DATABASE 'app-encrypted.db' AS encrypted KEY "x'<64 hex chars of SERVER_ENCRYPTION_KEY>'";
SELECT sqlcipher_export('encrypted');
DETACH DATABASE encrypted;
-- app-encrypted.db is now a full encrypted copy of the old plaintext data.
-- Verify it opens with the key (see below), then swap it in for app.db.
```

Get the hex form of `SERVER_ENCRYPTION_KEY` with:

```bash
node -e "console.log(Buffer.from(process.env.SERVER_ENCRYPTION_KEY, 'base64').toString('hex'))"
```

Do this offline, with the app stopped, and verify the new file opens (via
the app, or a `better-sqlite3-multiple-ciphers` script that keys it the same
way `src/db/sqlcipherKey.ts` does) before deleting the old plaintext copy.

### Verifying it's actually encrypted

Confirm at any time that `data/app.db` isn't readable without the key:

- The file's first 16 bytes should not be the literal string
  `SQLite format 3\0` — a plaintext SQLite file always starts with exactly
  that; an encrypted one is uniformly random-looking bytes.
- Opening it with a plain, un-keyed SQLite reader (the `sqlite3` CLI, or
  plain `better-sqlite3` with no key/cipher pragma set) should fail on the
  first real query with `file is not a database` — that's SQLCipher's actual
  literal error message for both "wrong key" and "no key at all", which is
  also why `src/db/client.ts` translates that specific error into an
  actionable message instead of letting it look like disk corruption.

## Docker / deploy

### Build and run locally

```bash
docker build -t what-to-watch:local .

# SERVER_ENCRYPTION_KEY must be freshly generated per the table above (or
# reused, if you're pointing at an existing ./data). ./data is a directory
# mount, never a single-file mount — see the TrueNAS note below for why
# that distinction matters.
docker run -d --name what-to-watch \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  -p 3000:3000 \
  what-to-watch:local
```

What happens on start (`docker-entrypoint.sh`): migrations run first, via
the same `tsx src/db/migrate.ts` `npm run db:migrate` uses locally — a
failed migration exits non-zero and the container never starts the server,
rather than serving against a broken schema. Then `node server.js` (Next's
standalone output) starts. `HEALTHCHECK` polls `GET /api/health` with
Node's built-in `http` module (there's no `curl` in `node:22-slim`, and none
is added just for this).

The image is a 3-stage build (`deps` → `build` → `runtime`) built around one
hard constraint: `better-sqlite3` (an npm alias for
`better-sqlite3-multiple-ciphers`, the SQLCipher fork — see `package.json`)
is a **native addon**. It's installed/compiled inside the Linux image, never
copied from a host — a `.node` binary built on Windows is not portable to
`node:22-slim`. The same applies to two of Phase 5's dependencies,
`onnxruntime-node` and `sharp` (both native, both used by
`@huggingface/transformers`). All three are in Next's own default
`serverExternalPackages` list (`better-sqlite3-multiple-ciphers` needs an
explicit entry in `next.config.ts` — see the comment there), which keeps
Next's bundler from touching them; the Dockerfile then copies each package
directory into the runtime stage explicitly rather than trusting Next's
file tracer to catch a native binary reached via a computed
`require()` path — verified by actually running the built image and doing a
keyed SQLCipher read and an offline embedding call inside it, not by
reading the Dockerfile.

**The ML embedding model is baked into the image, not downloaded at
request time.** `src/lib/ml/embed.ts` refuses to fetch model weights over
the network once `NODE_ENV=production` — a home NAS may have flaky or no
connectivity, and a multi-second-to-minutes download on someone's first
`/api/recommend` call (or worse, a hang) is not acceptable. The `build`
stage downloads the quantized `Xenova/all-MiniLM-L6-v2` model once (network
access at build time only) into `/app/models`, using
`@huggingface/transformers`' own hub-download/cache machinery so the file
layout matches exactly what the runtime's local-only lookup expects; the
`runtime` stage copies that directory in and sets `ML_MODEL_DIR=/app/models`
explicitly. This adds real but modest size to the image (~40MB for the
quantized model + tokenizer files) — see "Image size" below for the current
total.

### Image size

Currently **~480MB** (`docker inspect --format='{{.Size}}'`). Breakdown, in
order of contribution: `onnxruntime-node` + `sharp` native binaries (Phase
5's ML stack) are the largest single addition, `node:22-slim` base +
Next.js standalone server + `better-sqlite3-multiple-ciphers` come next, and
the vendored ML model adds the least (~40MB). Nothing here is unexpected
bloat — devDependencies are not shipped (only `tsx` + `esbuild`, needed to
run `migrate.ts` outside the Next bundle — see the Dockerfile's runtime
stage comments) — but it's worth knowing before you publish, especially if
you're metering TrueNAS pull bandwidth.

### Publishing a new image (CI)

`.github/workflows/publish.yml` builds and pushes on a version tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Tests (`npm run test`) and a plain `npm run build` both gate the Docker
build and push — either failing stops the job before anything is published.
Requires two repo secrets under Settings > Secrets and variables > Actions:
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a DockerHub access token, not
your account password). Publishes `yotam/what-to-watch:<version>` and
`:latest`, `linux/amd64` only — see the workflow file for why `linux/arm64`
is skipped for now (three native-module builds under QEMU emulation is
where that starts costing real CI time, not just a bit more).

### TrueNAS deploy

Deploy as a **Custom App via Docker Compose** (TrueNAS SCALE's "Custom App"
form has the same single-file-mount reliability problem noted below; the
Compose path avoids it). `docker-compose.yml` at the repo root:

- Pulls `yotam/what-to-watch:latest` — it does not build on the NAS.
- `env_file: .env` — copy `.env.example`, fill in the required vars plus
  `TUNNEL_TOKEN` (see below), upload/create it next to the compose file on
  the NAS.
- `./data:/app/data` — a **directory** mount. **Single-file host-path
  mounts are unreliable on TrueNAS** (they can silently resolve to the
  wrong or empty content) — this is a hard-won lesson from a previous app
  on the same box, not a theoretical concern. Mount directories only, even
  for something that's conceptually one file.
- No published ports on the `app` service — this is deliberate, not a
  missing `ports:` block. All traffic arrives through the `cloudflared`
  service over the compose network's internal DNS. Publishing a port here
  would reopen exactly the inbound-port exposure the Tunnel exists to
  avoid.

```bash
docker compose up -d
docker compose logs -f app          # confirm "Migrations applied." then "Ready"
docker compose ps                   # app should show (healthy)
```

## Cloudflare Tunnel setup

1. Cloudflare Zero Trust dashboard → Networks → Tunnels → **Create a
   tunnel** → choose the **Docker** connector. This gives you a
   `TUNNEL_TOKEN` — put it in `.env` on the NAS, never in
   `docker-compose.yml` directly.
2. In the same tunnel's **Public Hostname** tab, add a hostname (e.g.
   `watch.yourdomain.com`) pointing at service `HTTP` → `app:3000` — the
   compose network's internal DNS name and port (`EXPOSE 3000` in the
   Dockerfile), not `localhost` and not any host-published port (there
   isn't one).
3. Cloudflare Access: put at least `/signup` behind an Access policy (email
   OTP or your identity provider of choice) before this is reachable from
   the open internet — the app itself has no invite/allowlist system, so
   Access is the only gate between "open signup" and "open signup to
   literally anyone who finds the URL."
4. Set `SECURE_COOKIES=true` in `.env` once traffic is arriving over the
   Tunnel's HTTPS — the session cookie is dropped silently by browsers over
   plain http otherwise (see the variable table above).

## Backups

Two things must be backed up, and **they must be stored separately from
each other**:

1. `./data/app.db` (+ `-wal`/`-shm` if present) — the SQLCipher-encrypted
   database.
2. `SERVER_ENCRYPTION_KEY` — the only thing that can decrypt it.

A backup that bundles both together (the same snapshot, the same
tarball, the same cloud folder) protects **nothing**: whoever/whatever can
read one can read the other, which is exactly the scenario whole-database
encryption exists to defend against (see "Encryption at rest" above — the
threat model is a leaked/misplaced backup or a misconfigured share, not
just a compromised live host). Keep the key somewhere categorically
different from where the `.db` backup lives — a password manager, a
separate secrets store, printed and locked in a drawer — anywhere that
isn't "the same backup destination as the data."

**There is no recovery path if `SERVER_ENCRYPTION_KEY` is lost.** Not a
slow one, not an expensive one — none. SQLCipher reports a lost/wrong key
identically to file corruption (`file is not a database`); there's nothing
to brute-force and nothing support can restore. Losing the key means losing
every row in the database, permanently, by design. Treat it with at least
as much care as you'd treat the data itself — arguably more, since the data
is worthless without it anyway.

If you ever need to rotate the key, use the conversion procedure under
"Converting an existing plaintext database" above as a template (same
`ATTACH` / `sqlcipher_export` mechanism, just old-key → new-key instead of
none → key), done offline with the app stopped, and verify the new file
opens before deleting the old one or updating the live `SERVER_ENCRYPTION_KEY`.
