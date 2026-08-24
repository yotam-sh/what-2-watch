// ---------------------------------------------------------------------------
// Centralized environment validation.
//
// Every required secret is validated once, here, at module load — never read
// `process.env.X` directly elsewhere for these keys. Fail fast and loud: a
// missing or malformed secret should be an immediate, actionable startup
// error, not a cryptic failure three requests later inside some route
// handler. This mirrors the `_MISSING_SECRETS` / `sys.exit(1)` pattern in
// spotify-tracker/app.py — same intent, ported to TypeScript.
//
// `parseEnv` is exported separately from the `env` singleton so tests can
// exercise validation failures (a short SERVER_ENCRYPTION_KEY, etc.) without
// tripping the process.exit(1) below — see src/lib/env.test.ts.
// ---------------------------------------------------------------------------

import { z } from "zod";

function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function decodesToBytes(value: string, expectedBytes: number): boolean {
  try {
    return Buffer.from(value, "base64").length === expectedBytes;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // AES-256 key for serverVault (src/lib/crypto/serverVault.ts) AND the
  // SQLCipher key for the whole database file (src/db/sqlcipherKey.ts) — the
  // entire .db is encrypted at rest under this key, not just serverVault's
  // columns. Losing or rotating it without the migration procedure in
  // README.md loses the database; there is no recovery path by design.
  // Generate with:
  // `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  SERVER_ENCRYPTION_KEY: z
    .string()
    .min(1, "is required")
    .refine(isBase64, "must be base64-encoded")
    .refine((v) => decodesToBytes(v, 32), "must decode to exactly 32 bytes"),

  // Signing key for session JWTs (src/lib/auth/jwt.ts). Generate with:
  // `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),

  // TMDB v3 API key, from https://www.themoviedb.org/settings/api (Phase 3).
  // Required now (not just Phase 3) so a misconfigured deploy fails at boot
  // instead of only once metadata enrichment is reached.
  TMDB_API_KEY: z.string().min(1, "is required"),

  // Controls the `secure` flag on the session cookie (src/lib/auth/cookies.ts).
  // Must be "false" for local http:// dev and "true" behind the Cloudflare
  // Tunnel in production — a secure cookie is silently dropped by browsers
  // over plain http.
  SECURE_COOKIES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Optional Tautulli enrichment (Phase 2) — detected at config time, never
  // required, per the plan.
  TAUTULLI_URL: z.string().url().optional(),
  TAUTULLI_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Thrown by parseEnv on validation failure. Carries one human-readable
 *  string per bad/missing variable so callers can render them as a list. */
export class EnvValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment: ${issues.join("; ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/** Pure validation function — never exits the process. `source` defaults to
 *  `process.env` but is injectable so tests can validate arbitrary inputs. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }
  return result.data;
}

function loadEnv(): Env {
  try {
    return parseEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(
        "FATAL: invalid or missing environment variable(s):\n" +
          err.issues.map((issue) => `  - ${issue}`).join("\n") +
          "\n\nSet them in .env.local for local dev, or in the deployment " +
          "environment for production. See .env.example for what each one " +
          "is for and how to generate it.\n",
      );
      process.exit(1);
    }
    // Not a validation error (e.g. a programmer error in the schema itself)
    // — let it surface as a real stack trace rather than swallowing it.
    throw err;
  }
}

export const env = loadEnv();
