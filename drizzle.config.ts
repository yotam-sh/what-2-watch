// Config for the drizzle-kit CLI (`npm run db:generate`). This is a
// standalone Node process, not part of the Next.js app, so it needs its own
// .env loading — Next.js loads .env.local automatically, drizzle-kit does not.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/app.db",
  },
});
