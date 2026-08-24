import { describe, expect, it } from "vitest";
import {
  connectionSortKey,
  isConnectionCacheFresh,
  orderConnections,
  selectBestConnection,
  type CachedConnectionState,
  type PlexConnection,
} from "./resources";

function conn(overrides: Partial<PlexConnection>): PlexConnection {
  return {
    uri: "https://example.com:32400",
    protocol: "https",
    address: "example.com",
    port: 32400,
    local: false,
    relay: false,
    ipv6: false,
    ...overrides,
  };
}

describe("connectionSortKey / orderConnections (constraint 12)", () => {
  it("orders local before remote before relay", () => {
    const local = conn({ uri: "local", local: true });
    const remote = conn({ uri: "remote" });
    const relay = conn({ uri: "relay", relay: true });
    expect(orderConnections([relay, remote, local]).map((c) => c.uri)).toEqual([
      "local",
      "remote",
      "relay",
    ]);
  });

  it("within a tier, prefers https over http", () => {
    const http = conn({ uri: "http-local", local: true, protocol: "http" });
    const https = conn({ uri: "https-local", local: true, protocol: "https" });
    expect(orderConnections([http, https]).map((c) => c.uri)).toEqual(["https-local", "http-local"]);
  });

  it("within protocol, prefers IPv4 over IPv6", () => {
    const v6 = conn({ uri: "v6", local: true, ipv6: true });
    const v4 = conn({ uri: "v4", local: true, ipv6: false });
    expect(orderConnections([v6, v4]).map((c) => c.uri)).toEqual(["v4", "v6"]);
  });

  it("relay always loses to any non-relay regardless of protocol/ip", () => {
    const relayHttps = conn({ uri: "relay-https", relay: true, protocol: "https" });
    const remoteHttp = conn({ uri: "remote-http", protocol: "http", ipv6: true });
    expect(orderConnections([relayHttps, remoteHttp]).map((c) => c.uri)).toEqual([
      "remote-http",
      "relay-https",
    ]);
  });

  it("connectionSortKey is a total order consistent with orderConnections", () => {
    const a = conn({ local: true });
    const b = conn({ relay: true });
    expect(connectionSortKey(a)).toBeLessThan(connectionSortKey(b));
  });
});

describe("selectBestConnection", () => {
  it("prefers the most-preferred connection even if a less-preferred one answers first", async () => {
    const local = conn({ uri: "local", local: true });
    const relay = conn({ uri: "relay", relay: true });

    // Both succeed — relay "answers" but local should still win because of
    // ordering preference, not arrival speed (that's the whole point of the
    // "race but prefer, don't just take the fastest" design).
    const probe = async () => true;

    const winner = await selectBestConnection([relay, local], "token", probe);
    expect(winner?.uri).toBe("local");
  });

  it("falls through to the next-preferred candidate when the top choice fails", async () => {
    const local = conn({ uri: "local", local: true });
    const remote = conn({ uri: "remote" });
    const relay = conn({ uri: "relay", relay: true });

    const probe = async (c: PlexConnection) => c.uri !== "local"; // local fails (e.g. DNS-rebinding block)

    const winner = await selectBestConnection([relay, remote, local], "token", probe);
    expect(winner?.uri).toBe("remote");
  });

  it("returns null when every candidate fails", async () => {
    const local = conn({ uri: "local", local: true });
    const probe = async () => false;
    expect(await selectBestConnection([local], "token", probe)).toBeNull();
  });

  it("returns null for an empty candidate list", async () => {
    expect(await selectBestConnection([], "token", async () => true)).toBeNull();
  });

  it("probes every candidate concurrently rather than sequentially", async () => {
    const calls: string[] = [];
    const local = conn({ uri: "local", local: true });
    const relay = conn({ uri: "relay", relay: true });
    const probe = async (c: PlexConnection) => {
      calls.push(c.uri);
      return c.uri === "relay";
    };
    // Both should be invoked even though `local` (tried "first" in
    // preference order) fails — a sequential short-circuit would only ever
    // call `local`.
    await selectBestConnection([relay, local], "token", probe);
    expect(calls.sort()).toEqual(["local", "relay"]);
  });
});

describe("isConnectionCacheFresh", () => {
  const HOUR = 60 * 60 * 1000;

  it("is false with no cached uri", () => {
    const state: CachedConnectionState = { cachedConnectionUri: null, connectionCheckedAt: null };
    expect(isConnectionCacheFresh(state)).toBe(false);
  });

  it("is true just inside the TTL", () => {
    const now = 10 * HOUR;
    const state: CachedConnectionState = {
      cachedConnectionUri: "https://x",
      connectionCheckedAt: new Date(now - HOUR + 1000),
    };
    expect(isConnectionCacheFresh(state, now)).toBe(true);
  });

  it("is false once past the TTL", () => {
    const now = 10 * HOUR;
    const state: CachedConnectionState = {
      cachedConnectionUri: "https://x",
      connectionCheckedAt: new Date(now - HOUR - 1000),
    };
    expect(isConnectionCacheFresh(state, now)).toBe(false);
  });
});
