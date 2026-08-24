import { describe, expect, it } from "vitest";
import {
  decryptWithUserVault,
  deriveUserVaultKey,
  encryptWithUserVault,
  generateKdfSalt,
} from "./userVault";

describe("userVault key derivation", () => {
  it("is deterministic for the same password + salt", async () => {
    const salt = generateKdfSalt();
    const keyA = await deriveUserVaultKey("correct horse battery staple", salt);
    const keyB = await deriveUserVaultKey("correct horse battery staple", salt);
    expect(keyA.equals(keyB)).toBe(true);
  });

  it("produces a different key for a different salt (same password)", async () => {
    const saltA = generateKdfSalt();
    const saltB = generateKdfSalt();
    const keyA = await deriveUserVaultKey("same password", saltA);
    const keyB = await deriveUserVaultKey("same password", saltB);
    expect(keyA.equals(keyB)).toBe(false);
  });

  it("produces a different key for a different password (same salt)", async () => {
    const salt = generateKdfSalt();
    const keyA = await deriveUserVaultKey("password one", salt);
    const keyB = await deriveUserVaultKey("password two", salt);
    expect(keyA.equals(keyB)).toBe(false);
  });

  it("derives a 32-byte (AES-256) key", async () => {
    const key = await deriveUserVaultKey("whatever", generateKdfSalt());
    expect(key.length).toBe(32);
  });

  it("round-trips a plaintext through encrypt/decrypt with the derived key", async () => {
    const salt = generateKdfSalt();
    const key = await deriveUserVaultKey("hunter2", salt);
    const ciphertext = encryptWithUserVault(key, "plex-token-abc123");
    expect(decryptWithUserVault(key, ciphertext)).toBe("plex-token-abc123");
  });
});
