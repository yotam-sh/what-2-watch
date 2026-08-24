// The regression the OLD password-based design could never pass: a session
// surviving a process restart. The old design split a session in two — a
// JWT cookie (survived restart) plus an in-memory userVault-key map
// (sessionStore.ts, wiped on restart) — so the *user* stayed logged in but
// couldn't sync Plex again until they re-authenticated. Plex-only login
// deletes that second half entirely: the Plex token is under serverVault, a
// process-wide key from an env var, not a per-session secret. This test
// doesn't need to literally kill a process — it proves the property that
// makes restart-survival true: nothing on this path depends on any
// in-memory state that only a "process incarnation" holds. JWT_SECRET and
// SERVER_ENCRYPTION_KEY both come from env (stable across a restart); there
// is no third input.
import { describe, expect, it } from "vitest";
import { encryptWithServerVault } from "@/lib/crypto/serverVault";
import { decryptPlexToken, VaultKeyUnavailableError } from "@/lib/plex/token";
import { signSessionToken, verifySessionToken } from "./jwt";

describe("session survives a simulated restart", () => {
  it("the session JWT round-trips with zero in-memory session state involved", async () => {
    const token = await signSessionToken({ sub: "user-1", username: "yotam" });
    // "Restart": this call shares no in-process state with the one that
    // signed the token above beyond the env-derived secret key.
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ sub: "user-1", username: "yotam" });
  });

  it("the linked Plex token decrypts with vaultKey: undefined — the only way the app ever calls this now", () => {
    const plexToken = "real-plex-account-token";
    const tokenCiphertext = encryptWithServerVault(plexToken);

    // See src/lib/plex/link.ts: every call site passes vaultKey: undefined
    // post-migration, since there is no session-scoped key any more.
    const decrypted = decryptPlexToken({ keyScope: "server", tokenCiphertext, vaultKey: undefined });
    expect(decrypted).toBe(plexToken);
  });

  it("a legacy key_scope='user' row is permanently unrecoverable, not a 500 — documented, not a bug", () => {
    expect(() =>
      decryptPlexToken({ keyScope: "user", tokenCiphertext: "v1:x:y", vaultKey: undefined }),
    ).toThrow(VaultKeyUnavailableError);
  });
});
