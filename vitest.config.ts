// Vitest config. This project has no prior test framework anywhere in the
// user's repos, so this establishes the convention: *.test.ts colocated
// next to the module it tests, run with `npm run test`.
//
// `test.env` seeds a valid-looking set of required env vars before any test
// file's imports run. This matters because src/lib/env.ts validates
// process.env and calls process.exit(1) at *module load time* — without
// this, simply importing a module that transitively imports lib/env (e.g.
// serverVault.ts) would kill the whole test worker. Tests that specifically
// exercise validation failures call `parseEnv()` directly with their own
// fake input instead of relying on this ambient config.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      SERVER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      JWT_SECRET: "test-only-jwt-secret-at-least-32-characters-long",
      TMDB_API_KEY: "test-tmdb-key",
      SECURE_COOKIES: "false",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
