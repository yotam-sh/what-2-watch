// CLI entrypoint: `npm run tmdb:backfill` (optionally `-- --limit N`).
// Mirrors src/lib/ml/runBackfill.ts's role for the embedding backfill: an
// explicit, observable, operator-triggered step, never run implicitly by
// the app itself (thousands of TMDB requests must not surprise-run on every
// boot, and must never run inside the synchronous Plex sync route — see
// backfill.ts's file header). See backfill.ts for the resumable /
// priority-ordered / rate-limited logic this just invokes and reports on.
import { sqlite } from "@/db/client";
import { backfillTmdbEnrichment } from "./backfill";

function parseLimitArg(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1] !== undefined) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (arg?.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

async function main() {
  const limit = parseLimitArg(process.argv.slice(2));
  if (limit !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`[tmdb:backfill] running with --limit ${limit}`);
  }

  const result = await backfillTmdbEnrichment({
    limit,
    onProgress: ({ done, skipped, remaining }) => {
      // eslint-disable-next-line no-console
      console.log(`[tmdb:backfill] ${done} done, ${skipped} skipped, ${remaining} remaining...`);
    },
  });
  // eslint-disable-next-line no-console
  console.log(`Backfill complete: ${result.done} enriched, ${result.skipped} skipped.`);
  sqlite.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
