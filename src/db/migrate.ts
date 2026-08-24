// Applies pending migrations from src/db/migrations to ./data/app.db.
// Run via `npm run db:migrate`. Separate from client.ts because the app
// itself should never run migrations implicitly on every boot — that's an
// explicit, observable step (important once this runs unattended in Docker).
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite } from "./client";

migrate(db, { migrationsFolder: "./src/db/migrations" });
console.log("Migrations applied.");
sqlite.close();
