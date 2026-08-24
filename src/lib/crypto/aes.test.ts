import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, DecryptionError, encrypt } from "./aes";

function testKey(): Buffer {
  return randomBytes(32);
}

describe("aes encrypt/decrypt", () => {
  it("round-trips plaintext", () => {
    const key = testKey();
    const plaintext = "a plex token or some other secret string";
    const ciphertext = encrypt(key, plaintext);
    expect(decrypt(key, ciphertext).toString("utf8")).toBe(plaintext);
  });

  it("produces a self-describing v1:<nonce>:<data> envelope", () => {
    const key = testKey();
    const ciphertext = encrypt(key, "hello");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
  });

  it("uses a fresh nonce every call, so two encryptions of the same plaintext differ", () => {
    const key = testKey();
    const a = encrypt(key, "identical plaintext");
    const b = encrypt(key, "identical plaintext");
    expect(a).not.toBe(b);
    // but both still decrypt to the same thing
    expect(decrypt(key, a).toString("utf8")).toBe("identical plaintext");
    expect(decrypt(key, b).toString("utf8")).toBe("identical plaintext");
  });

  it("rejects tampered ciphertext", () => {
    const key = testKey();
    const ciphertext = encrypt(key, "don't tamper with me");
    const [version, nonce, data] = ciphertext.split(":");
    // Flip a bit in the base64 payload so the auth tag no longer matches.
    const tamperedBuf = Buffer.from(data!, "base64");
    tamperedBuf[0] = tamperedBuf[0]! ^ 0xff;
    const tampered = `${version}:${nonce}:${tamperedBuf.toString("base64")}`;

    expect(() => decrypt(key, tampered)).toThrow(DecryptionError);
  });

  it("rejects decryption with the wrong key", () => {
    const key = testKey();
    const wrongKey = testKey();
    const ciphertext = encrypt(key, "secret");
    expect(() => decrypt(wrongKey, ciphertext)).toThrow(DecryptionError);
  });

  it("rejects a malformed envelope", () => {
    const key = testKey();
    expect(() => decrypt(key, "not-a-valid-envelope")).toThrow(DecryptionError);
    expect(() => decrypt(key, "v2:AAAA:BBBB")).toThrow(DecryptionError);
  });

  it("rejects keys that aren't 32 bytes", () => {
    expect(() => encrypt(Buffer.alloc(16), "x")).toThrow();
  });
});
