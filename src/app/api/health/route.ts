// GET /api/health — liveness probe for Phase 6's Docker healthcheck.
// Deliberately requires no auth and returns no secrets: it must be safe to
// call from an unauthenticated container-orchestration process.
import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    version: packageJson.version,
    uptime: process.uptime(),
  });
}
