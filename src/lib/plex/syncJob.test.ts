// ---------------------------------------------------------------------------
// Tests for syncJob.ts's background-job orchestration — the fix for the
// 502-after-5,680ms incident (see that file's header): POST /api/plex/sync
// must never hold an HTTP response open for the scan. These tests exercise
// startOrGetSyncJob()/getSyncJob() directly rather than through the route
// (this codebase doesn't unit-test route.ts handlers — see the sibling
// *.test.ts files next to every other route's underlying lib module).
//
// syncLibraries/syncWatchlist/getLinkedServerContext/triggerPostSyncEnrichment
// are mocked out (same style as postSyncEnrich.test.ts) so no real Plex/
// TMDB/ML work happens; @/db/client points at a throwaway migrated SQLite
// file (librarySync.test.ts's pattern) so sync_state writes are exercised
// for real.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applySqlcipherKey } from "@/db/sqlcipherKey";
import * as schema from "@/db/schema";
import { env } from "@/lib/env";
import { PlexRequestError } from "@/lib/plex/http";
import { PlexNotLinkedError, PlexUnreachableError } from "@/lib/plex/link";
import { VaultKeyUnavailableError } from "@/lib/plex/token";

let dir: string;
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/db/client", () => ({
  get db() {
    return testDb;
  },
  get sqlite() {
    return sqlite;
  },
}));

const syncLibraries = vi.fn();
const syncWatchlist = vi.fn();
const getLinkedServerContext = vi.fn();
const triggerPostSyncEnrichment = vi.fn();

vi.mock("@/lib/plex/librarySync", () => ({
  syncLibraries: (...args: unknown[]) => syncLibraries(...args),
}));
vi.mock("@/lib/plex/discoverSync", () => ({
  syncWatchlist: (...args: unknown[]) => syncWatchlist(...args),
}));
vi.mock("@/lib/plex/link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plex/link")>();
  return {
    ...actual,
    getLinkedServerContext: (...args: unknown[]) => getLinkedServerContext(...args),
  };
});
vi.mock("@/lib/plex/postSyncEnrich", () => ({
  triggerPostSyncEnrichment: (...args: unknown[]) => triggerPostSyncEnrichment(...args),
}));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-syncjob-test-"));
  const dbPath = path.join(dir, "test.db");
  sqlite = new Database(dbPath);
  applySqlcipherKey(sqlite, env.SERVER_ENCRYPTION_KEY);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(__dirname, "..", "..", "db", "migrations") });
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Flushes pending microtasks (e.g. a mocked-resolved getLinkedServerContext
 *  continuing on to call syncLibraries) without waiting for the whole job to
 *  settle — setImmediate runs after the microtask queue drains, so this is
 *  enough to observe "the next mocked call has happened" without racing it. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let userCounter = 0;
function makeUser(): { id: string; username: string } {
  userCounter += 1;
  const handle = `syncjob-user-${userCounter}`;
  const row = testDb
    .insert(schema.users)
    .values({ plexAccountId: handle, plexUsername: handle, plexEmail: `${handle}@example.com` })
    .returning()
    .get();
  return { id: row.id, username: row.plexUsername };
}

const okLibraryResult = {
  moviesSynced: 5,
  showsSynced: 2,
  libraryItemsSynced: 40,
  includeGuidsWorked: true,
  scanVariant: "includeGuids" as const,
};
const okWatchlistResult = { synced: 3, unresolved: 1 };

beforeEach(() => {
  syncLibraries.mockReset().mockResolvedValue(okLibraryResult);
  syncWatchlist.mockReset().mockResolvedValue(okWatchlistResult);
  getLinkedServerContext.mockReset().mockResolvedValue({
    linkId: "link-1",
    machineIdentifier: "machine-1",
    token: "token",
    clientIdentifier: "client-1",
    connectionUri: "http://192.168.1.50:32400",
  });
  triggerPostSyncEnrichment.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  const { __resetSyncJobsForTest } = await import("./syncJob");
  __resetSyncJobsForTest();
  vi.restoreAllMocks();
  testDb.delete(schema.syncState).run();
});

describe("startOrGetSyncJob", () => {
  it("returns immediately with a running job, without awaiting the scan", async () => {
    const { startOrGetSyncJob } = await import("./syncJob");
    const user = makeUser();

    let releaseScan!: (v: typeof okLibraryResult) => void;
    syncLibraries.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseScan = resolve;
        }),
    );

    const job = startOrGetSyncJob(user);

    // startOrGetSyncJob is synchronous and already returned — the scan's
    // promise is still unresolved, proving this call never awaited it.
    expect(job.status).toBe("running");
    expect(job.phase).toBe("scanning-library");

    // Let the mocked getLinkedServerContext's promise resolve and the
    // background job reach the (still-pending) syncLibraries() call.
    await tick();
    expect(syncLibraries).toHaveBeenCalledTimes(1);

    // Clean up: let the in-flight scan finish so it doesn't leak into the
    // next test.
    releaseScan(okLibraryResult);
    const { __waitForSyncJobForTest } = await import("./syncJob");
    await __waitForSyncJobForTest(user.id);
  });

  it("returns the existing job — not a new one — for a second start while running", async () => {
    const { startOrGetSyncJob } = await import("./syncJob");
    const user = makeUser();

    let releaseScan!: (v: typeof okLibraryResult) => void;
    syncLibraries.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseScan = resolve;
        }),
    );

    const first = startOrGetSyncJob(user);
    await tick(); // let the first job reach its (now-pending) syncLibraries() call
    const second = startOrGetSyncJob(user);

    expect(second).toBe(first); // same object — no second job was created
    expect(syncLibraries).toHaveBeenCalledTimes(1); // no duplicate scan launched

    releaseScan(okLibraryResult);
    const { __waitForSyncJobForTest } = await import("./syncJob");
    await __waitForSyncJobForTest(user.id);
  });

  it("transitions running -> completed with final counts, and fires post-sync enrichment", async () => {
    const { startOrGetSyncJob, getSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const user = makeUser();

    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);

    const job = getSyncJob(user.id);
    expect(job.status).toBe("completed");
    expect(job.phase).toBe("done");
    expect(job.moviesSynced).toBe(5);
    expect(job.showsSynced).toBe(2);
    expect(job.libraryItemsSynced).toBe(40);
    expect(job.scanVariant).toBe("includeGuids");
    expect(job.watchlistSynced).toBe(3);
    expect(job.watchlistUnresolved).toBe(1);
    expect(job.error).toBeNull();
    expect(triggerPostSyncEnrichment).toHaveBeenCalledTimes(1);

    const stateRow = testDb
      .select()
      .from(schema.syncState)
      .where(and(eq(schema.syncState.userId, user.id), eq(schema.syncState.source, "plex")))
      .get();
    expect(stateRow?.lastError).toBeNull();
    expect(stateRow?.lastRunAt).not.toBeNull();
  });

  it("moves the job's phase to syncing-watchlist between the library scan and the watchlist sync", async () => {
    const { startOrGetSyncJob, getSyncJob } = await import("./syncJob");
    const user = makeUser();

    let releaseWatchlist!: (v: typeof okWatchlistResult) => void;
    syncWatchlist.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWatchlist = resolve;
        }),
    );

    startOrGetSyncJob(user);
    await tick();
    // syncLibraries already resolved (mockResolvedValue), syncWatchlist is
    // still pending — the job should already have moved past
    // "scanning-library".
    expect(getSyncJob(user.id).phase).toBe("syncing-watchlist");

    releaseWatchlist(okWatchlistResult);
    const { __waitForSyncJobForTest } = await import("./syncJob");
    await __waitForSyncJobForTest(user.id);
    expect(getSyncJob(user.id).status).toBe("completed");
  });

  it("a new start is allowed once the previous job for that user has settled", async () => {
    const { startOrGetSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const user = makeUser();

    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);
    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);

    expect(syncLibraries).toHaveBeenCalledTimes(2);
  });

  it("two different users get independent jobs, neither blocking the other", async () => {
    const { startOrGetSyncJob, getSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const userA = makeUser();
    const userB = makeUser();

    startOrGetSyncJob(userA);
    startOrGetSyncJob(userB);
    await Promise.all([__waitForSyncJobForTest(userA.id), __waitForSyncJobForTest(userB.id)]);

    expect(getSyncJob(userA.id).status).toBe("completed");
    expect(getSyncJob(userB.id).status).toBe("completed");
    expect(syncLibraries).toHaveBeenCalledTimes(2);
  });

  it("yields failed + an error message, and still records sync_state.last_error, when the scan throws", async () => {
    const { startOrGetSyncJob, getSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const user = makeUser();
    syncLibraries.mockRejectedValue(new Error("PMS timed out"));

    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);

    const job = getSyncJob(user.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("PMS timed out");
    expect(triggerPostSyncEnrichment).not.toHaveBeenCalled();

    const stateRow = testDb
      .select()
      .from(schema.syncState)
      .where(and(eq(schema.syncState.userId, user.id), eq(schema.syncState.source, "plex")))
      .get();
    expect(stateRow?.lastError).toBe("PMS timed out");
  });

  it("retries once on PlexRequestError with forceReprobe, and succeeds if the retry works", async () => {
    const { startOrGetSyncJob, getSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const user = makeUser();

    getLinkedServerContext
      .mockRejectedValueOnce(new PlexRequestError("stale connection", 502, "http://old-uri/"))
      .mockResolvedValueOnce({
        linkId: "link-1",
        machineIdentifier: "machine-1",
        token: "token",
        clientIdentifier: "client-1",
        connectionUri: "http://192.168.1.99:32400",
      });

    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);

    expect(getLinkedServerContext).toHaveBeenCalledTimes(2);
    expect(getLinkedServerContext).toHaveBeenNthCalledWith(1, user, { forceReprobe: false });
    expect(getLinkedServerContext).toHaveBeenNthCalledWith(2, user, { forceReprobe: true });
    expect(getSyncJob(user.id).status).toBe("completed");
  });

  it("fails with 'Plex is not linked.' and does NOT record sync_state for PlexNotLinkedError", async () => {
    const { startOrGetSyncJob, getSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const user = makeUser();
    getLinkedServerContext.mockRejectedValue(new PlexNotLinkedError());

    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);

    const job = getSyncJob(user.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("Plex is not linked.");

    const stateRow = testDb
      .select()
      .from(schema.syncState)
      .where(and(eq(schema.syncState.userId, user.id), eq(schema.syncState.source, "plex")))
      .get();
    expect(stateRow).toBeUndefined();
  });

  it("fails with a session-expired message for VaultKeyUnavailableError, without recording sync_state", async () => {
    const { startOrGetSyncJob, getSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const user = makeUser();
    getLinkedServerContext.mockRejectedValue(new VaultKeyUnavailableError());

    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);

    expect(getSyncJob(user.id).error).toBe("Your session expired. Please log in again to sync.");
    const stateRow = testDb
      .select()
      .from(schema.syncState)
      .where(and(eq(schema.syncState.userId, user.id), eq(schema.syncState.source, "plex")))
      .get();
    expect(stateRow).toBeUndefined();
  });

  it("fails and records sync_state for PlexUnreachableError", async () => {
    const { startOrGetSyncJob, getSyncJob, __waitForSyncJobForTest } = await import("./syncJob");
    const user = makeUser();
    getLinkedServerContext.mockRejectedValue(new PlexUnreachableError());

    startOrGetSyncJob(user);
    await __waitForSyncJobForTest(user.id);

    const job = getSyncJob(user.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("Could not reach the linked Plex server on any known connection");

    const stateRow = testDb
      .select()
      .from(schema.syncState)
      .where(and(eq(schema.syncState.userId, user.id), eq(schema.syncState.source, "plex")))
      .get();
    expect(stateRow?.lastError).toBe("Could not reach the linked Plex server on any known connection");
  });
});

describe("getSyncJob", () => {
  it("returns an idle job for a user this process has never tracked", async () => {
    const { getSyncJob } = await import("./syncJob");
    expect(getSyncJob("no-such-user")).toEqual({
      status: "idle",
      phase: null,
      startedAt: null,
      completedAt: null,
      scanVariant: null,
      moviesSynced: null,
      showsSynced: null,
      libraryItemsSynced: null,
      includeGuidsWorked: null,
      watchlistSynced: null,
      watchlistUnresolved: null,
      error: null,
    });
  });
});
