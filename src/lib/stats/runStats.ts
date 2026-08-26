// `npm run stats` — a read-only report on what the app knows and whether the
// learning layers are close to switching on.
//
// This exists because the database is SQLCipher-encrypted, which makes
// "just open it and look" harder than it sounds: the ordinary sqlite3 CLI
// reports a wrong/absent key as "file is not a database", indistinguishable
// from corruption. Rather than hand the key to an external tool, this script
// reuses the app's own db/client (which already knows the cipher and the raw
// hex key from SERVER_ENCRYPTION_KEY) and prints the numbers.
//
// Locally that's `npm run stats`. In the container it is NOT — the Dockerfile
// copies node_modules/tsx but not node_modules/.bin, so `npm run` cannot
// resolve the `tsx` binary and fails with "tsx: not found". Use the same
// explicit form the migration step and the two backfill CLIs already use:
//
//     docker compose exec app node ./node_modules/tsx/dist/cli.mjs \
//         ./src/lib/stats/runStats.ts
//
// so there's no key handling, no copying a decryptable database onto a
// laptop, and no second implementation of the cipher setup to keep in step.
//
// Read-only by construction: every statement below is a SELECT.
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { CF_MIN_POSITIVE_SIGNALS, CF_MIN_USERS } from "@/lib/ml/cf";
import { LTR_MIN_LABELED_INTERACTIONS } from "@/lib/ml/ltr";

function rows<T = Record<string, unknown>>(q: string): T[] {
  return db.all(sql.raw(q)) as T[];
}

function one(q: string): number {
  const r = rows<{ n: number }>(q)[0];
  return r ? Number(r.n) : 0;
}

function heading(s: string): void {
  console.log(`\n${s}\n${"-".repeat(s.length)}`);
}

function line(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

function main(): void {
  heading("Accounts");
  const userCount = one("SELECT COUNT(*) n FROM users");
  line("users", userCount);
  line("plex links", one("SELECT COUNT(*) n FROM plex_links"));
  line("letterboxd links", one("SELECT COUNT(*) n FROM letterboxd_links"));
  line("selected plex servers", one("SELECT COUNT(*) n FROM plex_selected_servers"));

  heading("Catalogue");
  for (const r of rows<{ media_type: string; n: number }>(
    "SELECT media_type, COUNT(*) n FROM titles GROUP BY 1",
  )) {
    line(`titles (${r.media_type})`, r.n);
  }
  line("enriched (genres set)", one("SELECT COUNT(*) n FROM titles WHERE genres IS NOT NULL"));
  line("embedded", one("SELECT COUNT(*) n FROM titles WHERE embedding IS NOT NULL"));
  line("watchlist items", one("SELECT COUNT(*) n FROM watchlist_items"));

  heading("Plex library");
  for (const r of rows<{ type: number; unresolved: number; n: number }>(
    "SELECT type, (tmdb_id IS NULL) unresolved, COUNT(*) n FROM plex_items GROUP BY 1,2 ORDER BY 1,2",
  )) {
    const kind = r.type === 1 ? "movie" : r.type === 2 ? "show" : `type ${r.type}`;
    line(`${kind} (${r.unresolved ? "UNRESOLVED" : "resolved"})`, r.n);
  }

  heading("Watch signal");
  for (const r of rows<{ source: string; n: number; rated: number }>(
    "SELECT source, COUNT(*) n, SUM(rating IS NOT NULL) rated FROM watch_events GROUP BY 1",
  )) {
    line(`${r.source} events`, `${r.n} (${r.rated ?? 0} rated)`);
  }
  line(
    "letterboxd >= 3.5 (taste input)",
    one("SELECT COUNT(*) n FROM watch_events WHERE source='letterboxd' AND rating >= 3.5"),
  );
  line("plex view_count >= 2 (taste input)", one("SELECT COUNT(*) n FROM plex_items WHERE view_count >= 2"));

  heading("Sync");
  for (const r of rows<{ source: string; last_run_at: number | null; last_error: string | null }>(
    "SELECT source, last_run_at, last_error FROM sync_state",
  )) {
    const when = r.last_run_at ? new Date(r.last_run_at * 1000).toISOString() : "never";
    const age = r.last_run_at
      ? ` (${Math.floor((Date.now() - r.last_run_at * 1000) / 3_600_000)}h ago)`
      : "";
    line(`${r.source} last run`, `${when}${age}`);
    if (r.last_error) line(`${r.source} last error`, r.last_error);
  }

  heading("Learning layers");
  const byAction = rows<{ action: string; n: number }>(
    "SELECT action, COUNT(*) n FROM interactions GROUP BY 1",
  );
  for (const r of byAction) line(`interactions: ${r.action}`, r.n);

  // Only picked/skipped/snoozed are labels — a 'shown' row records that a
  // candidate was surfaced, not what the user thought of it.
  const labeled = one("SELECT COUNT(*) n FROM interactions WHERE action IN ('picked','skipped','snoozed')");
  const models = one("SELECT COUNT(*) n FROM ltr_models");
  line("labeled interactions", `${labeled} / ${LTR_MIN_LABELED_INTERACTIONS} needed`);
  line(
    "learn-to-rank",
    models > 0
      ? "TRAINED — influencing rolls"
      : labeled >= LTR_MIN_LABELED_INTERACTIONS
        ? "threshold met, but no model row — training is not wired up"
        : `waiting for ${LTR_MIN_LABELED_INTERACTIONS - labeled} more verdicts`,
  );

  const positives = one("SELECT COUNT(*) n FROM interactions WHERE action = 'picked'");
  const cfReady = userCount >= CF_MIN_USERS && positives >= CF_MIN_POSITIVE_SIGNALS;
  line("cf users", `${userCount} / ${CF_MIN_USERS} needed`);
  line("cf positive signals", `${positives} / ${CF_MIN_POSITIVE_SIGNALS} needed`);
  line("collaborative filtering", cfReady ? "gate open" : "gated off");

  console.log("");
}

main();
