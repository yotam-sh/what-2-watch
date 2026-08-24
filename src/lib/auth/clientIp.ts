// Best-effort client IP extraction, used only as a rate-limit key.
// Behind the planned Cloudflare Tunnel, `x-forwarded-for` carries the real
// client IP. Falls back to a constant rather than throwing so local dev
// (single machine, no proxy headers) still rate-limits sanely.
import type { NextRequest } from "next/server";

export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]!.trim();
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}
