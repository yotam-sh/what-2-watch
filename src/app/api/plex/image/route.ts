// GET /api/plex/image?path=/library/metadata/123/thumb/167832
//
// Server-side poster/artwork proxy — the only way art ever reaches the
// browser, since the Plex token must never reach it (constraint 11) and PMS
// itself is frequently unreachable from a public HTTPS PWA (LAN-only http,
// `plex.direct` DNS-rebinding blocks, etc.).
//
// SSRF guard: `path` must be a Plex-relative path (starts with "/", contains
// no "://") and is always appended to the *cached, validated* connection URI
// this app already resolved and stored for the caller's own linked server —
// never to a host the caller supplies. There is no way to make this route
// fetch an arbitrary URL.
import { NextRequest, NextResponse } from "next/server";
import { getOptionalUser } from "@/lib/auth/guards";
import { PlexRequestError } from "@/lib/plex/http";
import { getLinkedServerContext, PlexNotLinkedError, PlexUnreachableError } from "@/lib/plex/link";
import { VaultKeyUnavailableError } from "@/lib/plex/token";

function isSafeRelativePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("://")) return false;
  if (path.includes("..")) return false; // no path traversal games either
  return true;
}

export async function GET(request: NextRequest) {
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const authedUser = user; // narrow once so the closure below sees a non-null type

  const path = request.nextUrl.searchParams.get("path");
  if (!path || !isSafeRelativePath(path)) {
    return NextResponse.json({ error: "Invalid image path." }, { status: 400 });
  }
  const safePath = path; // same narrowing issue for the string | null param

  async function fetchImage(forceReprobe: boolean) {
    const ctx = await getLinkedServerContext(authedUser, { forceReprobe });
    const upstream = await fetch(`${ctx.connectionUri}${safePath}`, {
      headers: { "X-Plex-Token": ctx.token, Accept: "image/*" },
    });
    if (!upstream.ok) {
      throw new PlexRequestError(`Image fetch failed (${upstream.status})`, upstream.status, safePath);
    }
    return upstream;
  }

  try {
    let upstream;
    try {
      upstream = await fetchImage(false);
    } catch (err) {
      if (err instanceof PlexRequestError) {
        upstream = await fetchImage(true);
      } else {
        throw err;
      }
    }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    const buf = await upstream.arrayBuffer();
    return new NextResponse(buf, {
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (err) {
    if (err instanceof PlexNotLinkedError) {
      return NextResponse.json({ error: "Plex is not linked." }, { status: 400 });
    }
    if (err instanceof VaultKeyUnavailableError) {
      return NextResponse.json({ error: "Session expired." }, { status: 401 });
    }
    if (err instanceof PlexUnreachableError || err instanceof PlexRequestError) {
      return NextResponse.json({ error: "Could not reach Plex server." }, { status: 502 });
    }
    return NextResponse.json({ error: "Failed to fetch image." }, { status: 500 });
  }
}
