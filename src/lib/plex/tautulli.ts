// ---------------------------------------------------------------------------
// Optional Tautulli enrichment.
//
// Never required — detected purely at config time via TAUTULLI_URL /
// TAUTULLI_API_KEY (both optional in src/lib/env.ts). The app must work
// fully without it; every export here is additive, feeding `duration`,
// `percent_complete`, `watched_status`, and `reference_id` play-grouping
// that raw Plex library scans can't provide.
//
// Ports the paging approach and, especially, the `sanitize()` logic from
// c:\python\repos\tautulli-streamlit\fetch_data.py: Tautulli's API mixes
// ints, strings, and '' in the same column (e.g. rating_key comes back as
// an int most of the time and '' when a play has no associated item), which
// breaks anything expecting one consistent type. The Python version decides
// per-*column*, over a whole pandas DataFrame, whether coercing to numeric
// preserves the same null pattern; sanitizeHistoryRows below reproduces that
// decision per-column over a plain array of row objects since there's no
// dataframe here.
//
// CONSTRAINT: join Tautulli rows to Plex items on `rating_key` +
// `machine_identifier`, NEVER on `guid` — Tautulli often reports the legacy
// agent guid even for a modern-agent library, which would silently produce
// wrong or missing joins.
// ---------------------------------------------------------------------------

import { env } from "@/lib/env";

const PAGE_SIZE = 1000;

export interface TautulliConfig {
  baseUrl: string;
  apiKey: string;
}

/** Returns the config iff both env vars are set, else null — the one place
 *  the rest of the app should check "is Tautulli configured?". */
export function getTautulliConfig(): TautulliConfig | null {
  if (!env.TAUTULLI_URL || !env.TAUTULLI_API_KEY) return null;
  return { baseUrl: env.TAUTULLI_URL.replace(/\/$/, ""), apiKey: env.TAUTULLI_API_KEY };
}

interface TautulliApiEnvelope<T> {
  response: { result: string; message?: string; data: T };
}

async function tautulliApiCall<T>(
  config: TautulliConfig,
  cmd: string,
  params: Record<string, string | number>,
): Promise<T> {
  const url = new URL(`${config.baseUrl}/api/v2`);
  url.searchParams.set("apikey", config.apiKey);
  url.searchParams.set("cmd", cmd);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Tautulli API error (${res.status}) for ${cmd}`);
  }
  const json = (await res.json()) as TautulliApiEnvelope<T>;
  if (json.response.result !== "success") {
    throw new Error(`Tautulli API error for ${cmd}: ${json.response.message ?? "unknown error"}`);
  }
  return json.response.data;
}

export type TautulliRow = Record<string, unknown>;

/** TS port of fetch_data.py's `sanitize()`. Operates column-wise across all
 *  rows (not per-row) because the original's decision — "is it safe to treat
 *  this whole column as numeric?" — depends on whether doing so changes
 *  which cells are considered missing across every row, not just one. `''`
 *  is always treated as a null placeholder, matching the Python version's
 *  `.replace("", None)` before the numeric-safety check. */
export function sanitizeHistoryRows(rows: TautulliRow[]): TautulliRow[] {
  if (rows.length === 0) return rows;
  const keys = Object.keys(rows[0]);

  const numericSafeKeys = new Set<string>();
  for (const key of keys) {
    let allCoercible = true;
    for (const row of rows) {
      const v = row[key];
      if (v === "" || v === null || v === undefined) continue; // null in both representations
      if (typeof v === "number") continue;
      if (typeof v !== "string" || v.trim() === "" || Number.isNaN(Number(v))) {
        allCoercible = false;
        break;
      }
    }
    if (allCoercible) numericSafeKeys.add(key);
  }

  return rows.map((row) => {
    const out: TautulliRow = {};
    for (const key of keys) {
      const v = row[key];
      if (v === "") {
        out[key] = null;
      } else if (numericSafeKeys.has(key) && typeof v === "string") {
        out[key] = Number(v);
      } else {
        out[key] = v;
      }
    }
    return out;
  });
}

/** Pages through get_history via start/length exactly like fetch_data.py's
 *  fetch_history(), then sanitizes the combined result. Not unit-tested
 *  directly (needs a live Tautulli instance) — sanitizeHistoryRows above
 *  carries the fixture-testable logic. */
export async function fetchTautulliHistory(config: TautulliConfig): Promise<TautulliRow[]> {
  const rows: TautulliRow[] = [];
  let start = 0;
  let total: number | null = null;

  while (total === null || start < total) {
    const data = await tautulliApiCall<{ recordsFiltered: number; data: TautulliRow[] }>(
      config,
      "get_history",
      { grouping: 1, start, length: PAGE_SIZE, order_column: "date", order_dir: "asc" },
    );
    total = data.recordsFiltered;
    const page = data.data;
    if (!page || page.length === 0) break;
    rows.push(...page);
    start += page.length;
  }

  return sanitizeHistoryRows(rows);
}

/** Joins sanitized Tautulli history rows to a single Plex item by
 *  rating_key + machine_identifier — never guid, per the constraint above.
 *  Tautulli's `get_history` rows may not carry a `machine_identifier` field
 *  on every install (single-server setups sometimes omit it); when it's
 *  absent on a row this falls back to matching on rating_key alone for that
 *  row, which is safe only because this app supports exactly one linked
 *  Plex server per user. This fallback is unverified against a live
 *  Tautulli instance — see the Phase 2 report. */
export function joinTautulliByRatingKey(
  plexRatingKey: string,
  machineIdentifier: string,
  tautulliRows: TautulliRow[],
): TautulliRow[] {
  return tautulliRows.filter((row) => {
    if (String(row.rating_key) !== plexRatingKey) return false;
    if (row.machine_identifier === undefined || row.machine_identifier === null) return true;
    return row.machine_identifier === machineIdentifier;
  });
}
