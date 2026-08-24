// ---------------------------------------------------------------------------
// Tests for the Plex server picker's selection + connection-resolution
// logic in link.ts. Same throwaway-migrated-DB-behind-a-mocked-@/db/client
// approach as account.test.ts (link.ts imports the shared db client
// directly) — findOrCreateUser/linkPlexToken from account.ts build real
// plex_links rows with real serverVault-encrypted tokens, exactly as the
// actual login flow does, so decryptPlexToken exercises the real path too.
//
// "./resources" (network I/O + the constraint-12 connection race) is
// mocked out here — these tests are about *which* server(s) get used, not
// *how* a connection to one is chosen. resources.test.ts already covers the
// race/ordering logic directly and is untouched by this feature.
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlexAccountIdentity } from "./pin";

vi.mock("@/db/client", async () => {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const Database = (await import("better-sqlite3-multiple-ciphers")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtw-link-test-"));
  const sqlite = new Database(path.join(dir, "test.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "db", "migrations") });

  return { db, sqlite };
});

const getPlexServers = vi.fn();
const resolveServerConnection = vi.fn();

vi.mock("./resources", () => ({
  getPlexServers: (...args: unknown[]) => getPlexServers(...args),
  resolveServerConnection: (...args: unknown[]) => resolveServerConnection(...args),
}));

interface FakeConn {
  uri: string;
  protocol: "https";
  address: string;
  port: number;
  local: boolean;
  relay: boolean;
  ipv6: boolean;
}

function server(overrides: { clientIdentifier: string; owned: boolean; name?: string }) {
  return {
    name: overrides.name ?? overrides.clientIdentifier,
    clientIdentifier: overrides.clientIdentifier,
    provides: ["server"],
    owned: overrides.owned,
    connections: [] as FakeConn[],
  };
}

/** Default resolveServerConnection stub: succeeds for any machineIdentifier
 *  with a URI derived from it, so individual tests only need to override the
 *  cases they care about. */
function okResolution(machineIdentifier: string) {
  return { uri: `https://${machineIdentifier}.example:32400`, changed: true };
}

let userCounter = 0;
async function makeLinkedUser(): Promise<{ id: string; username: string }> {
  userCounter += 1;
  const handle = `link-test-user-${userCounter}`;
  const { findOrCreateUser, linkPlexToken } = await import("./account");
  const identity: PlexAccountIdentity = {
    id: handle,
    username: handle,
    email: `${handle}@example.com`,
    thumb: null,
  };
  const user = findOrCreateUser(identity);
  linkPlexToken(user.id, { token: `token-for-${handle}`, freshClientIdentifier: `client-${handle}` });
  return { id: user.id, username: user.plexUsername };
}

afterAll(async () => {
  const { sqlite } = await import("@/db/client");
  sqlite.close();
});

beforeEach(() => {
  getPlexServers.mockReset();
  resolveServerConnection.mockReset().mockImplementation(async ({ machineIdentifier }: { machineIdentifier: string }) =>
    okResolution(machineIdentifier),
  );
});

describe("getLinkedServerContexts — selection replaces the old owned-then-first fallback", () => {
  it("uses the explicitly selected server, not owned-then-first, when a shared server was chosen over an owned one", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();

    const owned = server({ clientIdentifier: "owned-server", owned: true });
    const shared = server({ clientIdentifier: "shared-server", owned: false });
    getPlexServers.mockResolvedValue([owned, shared]);

    // Explicitly selected the SHARED server — the old
    // `servers.find(owned) ?? servers[0]` fallback would have picked
    // `owned-server` instead.
    db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "shared-server" }).run();

    const { getLinkedServerContexts } = await import("./link");
    const result = await getLinkedServerContexts(user);

    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].machineIdentifier).toBe("shared-server");
  });

  it("resolves multiple explicitly selected servers, one context each", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();

    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "server-a", owned: true }),
      server({ clientIdentifier: "server-b", owned: false }),
    ]);
    db.insert(plexSelectedServers).values([
      { userId: user.id, machineIdentifier: "server-a" },
      { userId: user.id, machineIdentifier: "server-b" },
    ]).run();

    const { getLinkedServerContexts } = await import("./link");
    const result = await getLinkedServerContexts(user);

    expect(result.contexts.map((c) => c.machineIdentifier).sort()).toEqual(["server-a", "server-b"]);
    expect(result.unreachable).toEqual([]);
  });
});

describe("getLinkedServerContexts — single-server auto-select (no picker)", () => {
  it("auto-selects a lone OWNED server and persists the selection", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();

    getPlexServers.mockResolvedValue([server({ clientIdentifier: "only-owned", owned: true })]);

    const { getLinkedServerContexts } = await import("./link");
    const result = await getLinkedServerContexts(user);

    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].machineIdentifier).toBe("only-owned");

    const rows = db.select().from(plexSelectedServers).where(eq(plexSelectedServers.userId, user.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].machineIdentifier).toBe("only-owned");
  });

  it("auto-selects a lone SHARED server too — the single-server rule doesn't care about ownership", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();

    getPlexServers.mockResolvedValue([server({ clientIdentifier: "only-shared", owned: false })]);

    const { getLinkedServerContexts } = await import("./link");
    const result = await getLinkedServerContexts(user);

    expect(result.contexts[0].machineIdentifier).toBe("only-shared");
    const rows = db.select().from(plexSelectedServers).where(eq(plexSelectedServers.userId, user.id)).all();
    expect(rows).toHaveLength(1);
  });

  it("does not re-run discovery/auto-select once a selection already exists", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "already-selected" }).run();

    const { getLinkedServerContexts } = await import("./link");
    await getLinkedServerContexts(user);

    expect(getPlexServers).not.toHaveBeenCalled();
  });
});

describe("getLinkedServerContexts — multiple servers, nothing selected yet", () => {
  it("throws PlexServerSelectionRequiredError instead of silently picking one (regression guard for the removed fallback)", async () => {
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "owned-1", owned: true }),
      server({ clientIdentifier: "shared-1", owned: false }),
    ]);

    const { getLinkedServerContexts, PlexServerSelectionRequiredError } = await import("./link");
    await expect(getLinkedServerContexts(user)).rejects.toThrow(PlexServerSelectionRequiredError);
  });

  it("a user with only shared servers (2+, none owned) can still select one via setSelectedServers, then syncs against it", async () => {
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "shared-a", owned: false }),
      server({ clientIdentifier: "shared-b", owned: false }),
    ]);

    const { getLinkedServerContexts, setSelectedServers, PlexServerSelectionRequiredError } = await import("./link");
    await expect(getLinkedServerContexts(user)).rejects.toThrow(PlexServerSelectionRequiredError);

    await setSelectedServers(user.id, ["shared-b"]);

    const result = await getLinkedServerContexts(user);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].machineIdentifier).toBe("shared-b");
  });
});

describe("getLinkedServerContexts — zero servers / unreachable handling", () => {
  it("throws PlexUnreachableError when discovery finds no servers at all", async () => {
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([]);

    const { getLinkedServerContexts, PlexUnreachableError } = await import("./link");
    await expect(getLinkedServerContexts(user)).rejects.toThrow(PlexUnreachableError);
  });

  it("returns the reachable servers and lists the rest as unreachable, rather than failing the whole call, on a partial connection failure", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    db.insert(plexSelectedServers).values([
      { userId: user.id, machineIdentifier: "up" },
      { userId: user.id, machineIdentifier: "down" },
    ]).run();

    resolveServerConnection.mockImplementation(async ({ machineIdentifier }: { machineIdentifier: string }) =>
      machineIdentifier === "down" ? null : okResolution(machineIdentifier),
    );

    const { getLinkedServerContexts } = await import("./link");
    const result = await getLinkedServerContexts(user);

    expect(result.contexts.map((c) => c.machineIdentifier)).toEqual(["up"]);
    expect(result.unreachable).toEqual(["down"]);
  });

  it("throws PlexUnreachableError only when EVERY selected server fails to resolve", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "down" }).run();
    resolveServerConnection.mockResolvedValue(null);

    const { getLinkedServerContexts, PlexUnreachableError } = await import("./link");
    await expect(getLinkedServerContexts(user)).rejects.toThrow(PlexUnreachableError);
  });
});

describe("getLinkedServerContext (singular wrapper)", () => {
  it("returns the first resolved context", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "solo" }).run();

    const { getLinkedServerContext } = await import("./link");
    const ctx = await getLinkedServerContext(user);
    expect(ctx.machineIdentifier).toBe("solo");
  });
});

describe("connection cache is per-selection", () => {
  it("persists the resolved URI onto that server's own plex_selected_servers row", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "cache-me" }).run();

    const { getLinkedServerContexts } = await import("./link");
    await getLinkedServerContexts(user);

    const row = db
      .select()
      .from(plexSelectedServers)
      .where(eq(plexSelectedServers.userId, user.id))
      .get();
    expect(row?.cachedConnectionUri).toBe("https://cache-me.example:32400");
    expect(row?.connectionCheckedAt).not.toBeNull();
  });

  it("passes each selected server's own cached connection state into resolveServerConnection", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    // Whole seconds only: the integer timestamp column round-trips through
    // SQLite as epoch seconds, so a sub-second Date wouldn't compare equal
    // after the read-back below.
    const checkedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    db.insert(plexSelectedServers)
      .values({
        userId: user.id,
        machineIdentifier: "warm",
        cachedConnectionUri: "https://previously-cached:32400",
        connectionCheckedAt: checkedAt,
      })
      .run();

    const { getLinkedServerContexts } = await import("./link");
    await getLinkedServerContexts(user);

    expect(resolveServerConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        machineIdentifier: "warm",
        cache: { cachedConnectionUri: "https://previously-cached:32400", connectionCheckedAt: checkedAt },
      }),
    );
  });
});

describe("listServersForPicker", () => {
  it("lists every discovered server and which are selected, without mutating anything for a multi-server account", async () => {
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "owned-x", owned: true }),
      server({ clientIdentifier: "shared-y", owned: false }),
    ]);

    const { listServersForPicker } = await import("./link");
    const { servers, selectedMachineIdentifiers } = await listServersForPicker(user.id);

    expect(servers.map((s) => s.clientIdentifier).sort()).toEqual(["owned-x", "shared-y"]);
    expect(selectedMachineIdentifiers.size).toBe(0);

    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    expect(db.select().from(plexSelectedServers).where(eq(plexSelectedServers.userId, user.id)).all()).toHaveLength(0);
  });

  it("marks previously selected servers as selected", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "owned-x", owned: true }),
      server({ clientIdentifier: "shared-y", owned: false }),
    ]);
    db.insert(plexSelectedServers).values({ userId: user.id, machineIdentifier: "shared-y" }).run();

    const { listServersForPicker } = await import("./link");
    const { selectedMachineIdentifiers } = await listServersForPicker(user.id);
    expect(selectedMachineIdentifiers).toEqual(new Set(["shared-y"]));
  });
});

describe("setSelectedServers", () => {
  it("persists a fresh selection", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "a", owned: true }),
      server({ clientIdentifier: "b", owned: false }),
    ]);

    const { setSelectedServers } = await import("./link");
    await setSelectedServers(user.id, ["a", "b"]);

    const rows = db.select().from(plexSelectedServers).where(eq(plexSelectedServers.userId, user.id)).all();
    expect(rows.map((r) => r.machineIdentifier).sort()).toEqual(["a", "b"]);
  });

  it("rejects a machine_identifier that isn't a server on this account", async () => {
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([server({ clientIdentifier: "a", owned: true })]);

    const { setSelectedServers, InvalidServerSelectionError } = await import("./link");
    await expect(setSelectedServers(user.id, ["not-my-server"])).rejects.toThrow(InvalidServerSelectionError);
  });

  it("rejects an empty selection — there is no 'select nothing' state", async () => {
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([server({ clientIdentifier: "a", owned: true })]);

    const { setSelectedServers, InvalidServerSelectionError } = await import("./link");
    await expect(setSelectedServers(user.id, [])).rejects.toThrow(InvalidServerSelectionError);
  });

  it("keeps the existing connection cache for a server that stays selected across a selection change", async () => {
    const { plexSelectedServers } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "keep", owned: true }),
      server({ clientIdentifier: "add", owned: false }),
      server({ clientIdentifier: "drop", owned: false }),
    ]);
    db.insert(plexSelectedServers)
      .values([
        { userId: user.id, machineIdentifier: "keep", cachedConnectionUri: "https://keep:32400", connectionCheckedAt: new Date() },
        { userId: user.id, machineIdentifier: "drop" },
      ])
      .run();

    const { setSelectedServers } = await import("./link");
    await setSelectedServers(user.id, ["keep", "add"]);

    const rows = db.select().from(plexSelectedServers).where(eq(plexSelectedServers.userId, user.id)).all();
    expect(rows.map((r) => r.machineIdentifier).sort()).toEqual(["add", "keep"]);
    const keepRow = rows.find((r) => r.machineIdentifier === "keep");
    expect(keepRow?.cachedConnectionUri).toBe("https://keep:32400"); // untouched, not re-probed
    const addRow = rows.find((r) => r.machineIdentifier === "add");
    expect(addRow?.cachedConnectionUri).toBeNull(); // brand new selection, no cache yet
  });

  it("deselecting a server retains its plex_items — watch history is not purged on deselect", async () => {
    const { plexSelectedServers, plexItems, titles } = await import("@/db/schema");
    const { db } = await import("@/db/client");
    const user = await makeLinkedUser();
    getPlexServers.mockResolvedValue([
      server({ clientIdentifier: "kept-server", owned: true }),
      server({ clientIdentifier: "deselected-server", owned: false }),
    ]);
    db.insert(plexSelectedServers)
      .values([
        { userId: user.id, machineIdentifier: "kept-server" },
        { userId: user.id, machineIdentifier: "deselected-server" },
      ])
      .run();

    db.insert(titles).values({ tmdbId: 42, mediaType: "movie", title: "Deselected Server Movie" }).run();
    db.insert(plexItems)
      .values({
        userId: user.id,
        machineIdentifier: "deselected-server",
        ratingKey: "rk-1",
        tmdbId: 42,
        mediaType: "movie",
        viewCount: 1,
      })
      .run();

    const { setSelectedServers } = await import("./link");
    await setSelectedServers(user.id, ["kept-server"]); // deselects "deselected-server"

    const selection = db.select().from(plexSelectedServers).where(eq(plexSelectedServers.userId, user.id)).all();
    expect(selection.map((r) => r.machineIdentifier)).toEqual(["kept-server"]);

    // The plex_items row for the deselected server is still there.
    const items = db.select().from(plexItems).where(eq(plexItems.userId, user.id)).all();
    expect(items).toHaveLength(1);
    expect(items[0].machineIdentifier).toBe("deselected-server");
  });
});
