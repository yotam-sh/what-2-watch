// CLI entrypoint: `npm run ml:backfill`. Mirrors src/db/migrate.ts's role —
// an explicit, observable, operator-triggered step, never run implicitly by
// the app itself (embedding a whole library is CPU-heavy; it must not
// surprise-run on every boot). See embedBackfill.ts for the resumable /
// rate-limited logic this just invokes and reports on.
import { sqlite } from "@/db/client";
import { backfillEmbeddings } from "./embedBackfill";

async function main() {
  const result = await backfillEmbeddings({
    onProgress: (processed, failed) => {
      // eslint-disable-next-line no-console
      console.log(`[ml:backfill] ${processed} embedded, ${failed} failed so far...`);
    },
  });
  // eslint-disable-next-line no-console
  console.log(`Backfill complete: ${result.processed} embedded, ${result.failed} failed.`);
  sqlite.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
