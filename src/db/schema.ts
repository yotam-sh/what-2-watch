// ---------------------------------------------------------------------------
// Drizzle schema — the complete Phase-1..6 data model.
//
// Only `users` is written to in Phase 1. Every other table exists now
// because later phases (Plex sync, Letterboxd/TMDB, ML) depend on the shape
// being stable and migratable from day one — retrofitting foreign keys and
// indexes onto a live table is far more painful than shipping them empty.
//
// Storage-format decisions (see the master plan, "Data model" section):
//   - `embedding` is a BLOB of raw Float32Array bytes, not a JSON array of
//     numbers. A 384-dim MiniLM vector as JSON text is ~4-6x larger than the
//     equivalent Float32Array buffer and requires parsing on every read;
//     since Phase 5 does brute-force cosine similarity over every title on
//     every request, reading straight into a Float32Array without a parse
//     step matters. Encode/decode with `new Float32Array(buf.buffer, ...)`.
//   - `genres` / `directors` / `cast` / `keywords` are JSON *text*, not
//     BLOBs. These are small, human-debuggable string arrays that get
//     displayed directly in the UI (or fed into Phase 5's embedding text) —
//     there's no performance case for binary packing, and SQLite's
//     `json_each()` can query into them directly if that's ever needed.
//   - Enum-like text columns (`media_type`, `source`, `action`, `key_scope`)
//     are validated with `check()` constraints rather than a real SQL enum
//     type, since SQLite has none.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  primaryKey,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from "drizzle-orm/sqlite-core";

// ---- shared helpers ----

/** Every table uses a UUIDv4 text primary key rather than an autoincrement
 *  int — ids need to be generated client-side (e.g. before a title's TMDB
 *  enrichment completes) and must never collide across a restore/import. */
const uuidPk = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

// ---- users ----
//
// Plex-only login (revised 2026-08-24): identity is the Plex account, not a
// local username/password. `plexAccountId` is the stable id plex.tv's
// `/api/v2/user` returns for a token and is therefore the natural key for
// find-or-create (see src/lib/plex/account.ts) — the profile fields below it
// are display-only and refreshed on every login, since a Plex username or
// email can change but the account id can't. There is deliberately no
// password/kdf_salt any more: the consequence the user explicitly accepted
// is that the Plex token can no longer be encrypted under a password-derived
// key (there is no password), so it moves to serverVault — see
// plex_links.key_scope below and src/lib/crypto/serverVault.ts.

export const users = sqliteTable(
  "users",
  {
    id: uuidPk(),
    plexAccountId: text("plex_account_id").notNull(),
    plexUsername: text("plex_username").notNull(),
    plexEmail: text("plex_email").notNull(),
    // Nullable: Plex accounts without a custom avatar have no thumb URL.
    plexThumb: text("plex_thumb"),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("users_plex_account_id_unique").on(table.plexAccountId)],
);

// ---- plex_links ----

export const plexLinks = sqliteTable(
  "plex_links",
  {
    id: uuidPk(),
    userId: text("user_id")
      .notNull()
      .unique() // one Plex link per user
      .references(() => users.id, { onDelete: "cascade" }),
    // Persisted forever once issued (constraint 3 in the plan) — regenerating
    // this forces every linked device to re-authorize.
    clientIdentifier: text("client_identifier").notNull(),
    // Self-describing AES-GCM envelope ("v1:<nonce>:<ciphertext+tag>") from
    // src/lib/crypto/aes.ts. Deliberately no separate nonce column: the
    // nonce already lives inside this envelope, and duplicating it in a
    // sibling column would just create a second copy that could drift out
    // of sync with the one actually used to decrypt.
    tokenCiphertext: text("token_ciphertext").notNull(),
    // Which vault encrypted this token. Always 'server' for every row the
    // app writes post Plex-only-login migration (src/lib/plex/account.ts) —
    // there is no password any more to derive a 'user'-scope key from, and
    // the in-memory session-key store that used to hold it (sessionStore.ts)
    // was deleted along with it. 'user' stays in the CHECK constraint below
    // only so a hypothetical future passphrase option — userVault.ts is
    // deliberately not deleted, see that file's header — wouldn't need a
    // schema change to reuse it. src/lib/plex/token.ts still branches on
    // this column for exactly that reason.
    keyScope: text("key_scope").notNull().default("server"),
    machineIdentifier: text("machine_identifier"),
    cachedConnectionUri: text("cached_connection_uri"),
    connectionCheckedAt: integer("connection_checked_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (table) => [
    check("plex_links_key_scope_check", sql`${table.keyScope} IN ('user', 'server')`),
  ],
);

// ---- letterboxd_links ----

export const letterboxdLinks = sqliteTable(
  "letterboxd_links",
  {
    id: uuidPk(),
    userId: text("user_id")
      .notNull()
      .unique() // one Letterboxd link per user
      .references(() => users.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    // RSS <guid> of the most recent diary entry already ingested — the
    // dedupe key from constraint 18 in the plan.
    lastGuidSeen: text("last_guid_seen"),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
);

// ---- titles ----
// Natural key is (tmdb_id, media_type): the same numeric id is independently
// assigned to a movie and a tv show by TMDB, so tmdb_id alone cannot be a
// primary key. Every table below that references a title carries both
// columns for exactly this reason, even though the plan's shorthand lists
// only "tmdb_id" per table.

export const titles = sqliteTable(
  "titles",
  {
    tmdbId: integer("tmdb_id").notNull(),
    mediaType: text("media_type").notNull(),
    title: text("title").notNull(),
    year: integer("year"),
    runtime: integer("runtime"), // minutes
    genres: text("genres"), // JSON text array
    directors: text("directors"), // JSON text array
    cast: text("cast"), // JSON text array
    // JSON text array of TMDB keyword names. Fetched for free alongside
    // credits (see src/lib/tmdb/client.ts's append_to_response) but unused
    // until Phase 5, which feeds it into the embedding text alongside
    // genres/directors/cast/overview. Nullable like the others: NULL until a
    // title is actually enriched (see isEnriched() in src/lib/tmdb/store.ts).
    keywords: text("keywords"),
    overview: text("overview"),
    posterPath: text("poster_path"),
    // Raw Float32Array bytes (see file header). Null until Phase 5 embeds it.
    embedding: blob("embedding", { mode: "buffer" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (table) => [
    primaryKey({ columns: [table.tmdbId, table.mediaType] }),
    check("titles_media_type_check", sql`${table.mediaType} IN ('movie', 'tv')`),
  ],
);

// ---- plex_items ----
// One row per (user, Plex library item) as synced from library scans
// (constraint 5 — never the /status/sessions/history endpoint).

export const plexItems = sqliteTable(
  "plex_items",
  {
    id: uuidPk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    machineIdentifier: text("machine_identifier").notNull(),
    ratingKey: text("rating_key").notNull(),
    // Nullable: not every Plex item resolves to a TMDB id on first sync
    // (legacy-agent guids, unmatched items). NULL in either column disables
    // FK enforcement for that row, which is exactly the "not yet resolved"
    // state we need to allow.
    tmdbId: integer("tmdb_id"),
    mediaType: text("media_type"),
    librarySectionId: text("library_section_id"),
    // Plex `type`: 1=movie, 2=show, 3=season, 4=episode.
    type: integer("type"),
    viewCount: integer("view_count").default(0),
    lastViewedAt: integer("last_viewed_at", { mode: "timestamp" }),
    viewOffset: integer("view_offset"),
    leafCount: integer("leaf_count"),
    viewedLeafCount: integer("viewed_leaf_count"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("plex_items_user_item_unique").on(
      table.userId,
      table.machineIdentifier,
      table.ratingKey,
    ),
    index("plex_items_user_tmdb_idx").on(table.userId, table.tmdbId),
    foreignKey({
      columns: [table.tmdbId, table.mediaType],
      foreignColumns: [titles.tmdbId, titles.mediaType],
    }),
  ],
);

// ---- watch_events ----

export const watchEvents = sqliteTable(
  "watch_events",
  {
    id: uuidPk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tmdbId: integer("tmdb_id").notNull(),
    mediaType: text("media_type").notNull(),
    source: text("source").notNull(), // 'plex' | 'letterboxd'
    watchedAt: integer("watched_at", { mode: "timestamp" }).notNull(),
    rating: real("rating"), // Letterboxd half-star ratings, e.g. 4.5
    isRewatch: integer("is_rewatch", { mode: "boolean" }).default(false),
    createdAt: createdAt(),
  },
  (table) => [
    // Mandated by the plan: composite index for the user's-history-for-title
    // lookups that both the scorer and the reconciliation job need.
    index("watch_events_user_tmdb_idx").on(table.userId, table.tmdbId),
    check("watch_events_source_check", sql`${table.source} IN ('plex', 'letterboxd')`),
    foreignKey({
      columns: [table.tmdbId, table.mediaType],
      foreignColumns: [titles.tmdbId, titles.mediaType],
    }),
  ],
);

// ---- watchlist_items ----

export const watchlistItems = sqliteTable(
  "watchlist_items",
  {
    id: uuidPk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tmdbId: integer("tmdb_id").notNull(),
    mediaType: text("media_type").notNull(),
    source: text("source").notNull().default("plex_discover"),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("watchlist_items_user_title_unique").on(
      table.userId,
      table.tmdbId,
      table.mediaType,
    ),
    foreignKey({
      columns: [table.tmdbId, table.mediaType],
      foreignColumns: [titles.tmdbId, titles.mediaType],
    }),
  ],
);

// ---- interactions ----
// Every candidate the UI ever surfaces writes a row here — the only source
// of training data for the Phase 5 learn-to-rank model.

export const interactions = sqliteTable(
  "interactions",
  {
    id: uuidPk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tmdbId: integer("tmdb_id").notNull(),
    mediaType: text("media_type").notNull(),
    action: text("action").notNull(), // 'shown' | 'picked' | 'skipped' | 'snoozed'
    contextJson: text("context_json"), // freeform JSON: filters active, rank position, etc.
    createdAt: createdAt(),
  },
  (table) => [
    // Mandated by the plan.
    index("interactions_user_tmdb_idx").on(table.userId, table.tmdbId),
    check(
      "interactions_action_check",
      sql`${table.action} IN ('shown', 'picked', 'skipped', 'snoozed')`,
    ),
    foreignKey({
      columns: [table.tmdbId, table.mediaType],
      foreignColumns: [titles.tmdbId, titles.mediaType],
    }),
  ],
);

// ---- cf_item_factors / cf_user_factors ----
// Phase 5's hand-rolled implicit-feedback ALS (constraint 22: no ONNX
// training API exists, so CF is trained in plain TypeScript) needs somewhere
// to persist the two factor matrices it produces so scoring never retrains
// in the request path. New as of Phase 5 — not in the original plan's table
// list, added because there was genuinely nowhere else for this to live: the
// factors are derived from `watch_events`/`interactions` (rows the plan
// explicitly puts under whole-database encryption), so they belong inside
// the same SQLCipher-encrypted file rather than as loose files on disk next
// to it. See src/lib/ml/cf.ts.
//
// One row per title / per user, BLOB-encoded the same way as
// `titles.embedding` (raw Float32Array bytes via src/lib/ml/embed.ts's
// encode/decode helpers) for the same reason: cheap to read back with no
// JSON parse on the request path.

export const cfItemFactors = sqliteTable(
  "cf_item_factors",
  {
    tmdbId: integer("tmdb_id").notNull(),
    mediaType: text("media_type").notNull(),
    factors: blob("factors", { mode: "buffer" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tmdbId, table.mediaType] }),
    foreignKey({
      columns: [table.tmdbId, table.mediaType],
      foreignColumns: [titles.tmdbId, titles.mediaType],
    }),
  ],
);

export const cfUserFactors = sqliteTable("cf_user_factors", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  factors: blob("factors", { mode: "buffer" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// ---- ltr_models ----
// Per-user logistic learn-to-rank weights (src/lib/ml/ltr.ts), trained
// incrementally over `interactions`. Small enough (a handful of feature
// weights + a bias) that JSON text is the right encoding, same rationale
// schema.ts's file header gives for genres/directors/cast: human-debuggable,
// no perf case for binary packing at this size.

export const ltrModels = sqliteTable("ltr_models", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // JSON array of per-feature weights, in the fixed order LTR_FEATURE_ORDER
  // (src/lib/ml/ltr.ts) is defined in.
  weights: text("weights").notNull(),
  bias: real("bias").notNull(),
  // Count of labeled interactions this model has been trained on so far —
  // both the incremental-SGD bookkeeping and the gating threshold check.
  trainingCount: integer("training_count").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// ---- sync_state ----
// One row per (user, source) — bookkeeping for background pollers so a
// crashed run can report `last_error` instead of silently going stale.

export const syncState = sqliteTable(
  "sync_state",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // 'plex' | 'letterboxd'
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    lastError: text("last_error"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.source] })],
);
