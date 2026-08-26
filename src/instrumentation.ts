// Next.js instrumentation hook: `register()` runs once per server instance,
// before the server starts handling requests.
//
// THE TRAP THIS AVOIDS: `next build`'s "Collecting page data" step imports
// route modules to read their config, which is why CI has to run migrations
// before building at all (see .github/workflows/publish.yml). Anything that
// kicks off work at module scope therefore runs during the build too — a
// scheduler wired that way would start syncing on a CI runner. The guards
// below are what keep that from happening, so don't remove them because
// "register only runs on the server anyway".
//
// register() must also *complete* before the server is ready, so this only
// ever arms a timer and returns; it never performs a sync inline.
export async function register() {
  // Edge runtime has no timers worth arming and no database access.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Belt and braces against the build-time import path described above.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Explicit off switch, for local development and for any deploy that would
  // rather drive syncs by hand. Absent = on.
  if (process.env.AUTO_SYNC === "off") return;

  const { startScheduler } = await import("@/lib/sync/scheduler");
  startScheduler();
}
