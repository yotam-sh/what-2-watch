import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "./env";

const VALID_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SERVER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  JWT_SECRET: "a".repeat(32),
  TMDB_API_KEY: "some-tmdb-key",
  SECURE_COOKIES: "false",
};

describe("parseEnv", () => {
  it("accepts a fully valid environment", () => {
    const parsed = parseEnv(VALID_BASE);
    expect(parsed.SERVER_ENCRYPTION_KEY).toBe(VALID_BASE.SERVER_ENCRYPTION_KEY);
    expect(parsed.SECURE_COOKIES).toBe(false); // transformed to boolean
  });

  it("rejects a SERVER_ENCRYPTION_KEY that isn't valid base64", () => {
    expect(() =>
      parseEnv({ ...VALID_BASE, SERVER_ENCRYPTION_KEY: "not base64!!" }),
    ).toThrow(EnvValidationError);
  });

  it("rejects a SERVER_ENCRYPTION_KEY that decodes to the wrong length", () => {
    // Valid base64, but only 16 bytes once decoded (AES-128, not AES-256).
    const tooShort = Buffer.alloc(16, 1).toString("base64");
    expect(() => parseEnv({ ...VALID_BASE, SERVER_ENCRYPTION_KEY: tooShort })).toThrow(
      EnvValidationError,
    );
  });

  it("rejects a missing SERVER_ENCRYPTION_KEY", () => {
    const rest = { ...VALID_BASE };
    delete rest.SERVER_ENCRYPTION_KEY;
    expect(() => parseEnv(rest)).toThrow(EnvValidationError);
  });

  it("rejects a JWT_SECRET shorter than 32 characters", () => {
    expect(() => parseEnv({ ...VALID_BASE, JWT_SECRET: "too-short" })).toThrow(EnvValidationError);
  });

  it("rejects a missing TMDB_API_KEY", () => {
    const rest = { ...VALID_BASE };
    delete rest.TMDB_API_KEY;
    expect(() => parseEnv(rest)).toThrow(EnvValidationError);
  });

  it("collects multiple issues in one error rather than stopping at the first", () => {
    try {
      parseEnv({ NODE_ENV: "test" });
      expect.fail("expected parseEnv to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThan(1);
    }
  });
});
