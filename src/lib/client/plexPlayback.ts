// Client-side wrapper around the Plex Companion routes.
//
// The whole reason this is a module rather than three inline fetches is the
// confirmation dance, which is genuinely easy to get wrong:
//
//   - POST /api/plex/play only reports that a command was SENT. Whether
//     anything plays is unknowable for ~8 seconds and visible only in the
//     server's session list.
//   - So this polls GET /api/plex/play/status until the session appears.
//   - And if it never appears, it STOPS the player before reporting failure.
//     A timeout is not proof of failure — it may be a slow success — and an
//     unclaimed stream keeps running, burning a transcode slot and
//     eventually recording a watch event for a film nobody watched. That
//     poisons the taste model this app is built on. It happened for real
//     during development, and Tautulli caught it, not the app.
import { postJson } from "./http";

export interface PlexPlayer {
  machineIdentifier: string;
  name: string;
  product: string;
  serverMachineIdentifier: string;
  busy: { title: string; ratingKey: string } | null;
}

const POLL_INTERVAL_MS = 2000;
/** ~8s cold, ~4s warm when measured against real hardware; 20s is headroom
 *  for a sleepy client without an unbounded spinner. */
const CONFIRM_TIMEOUT_MS = 20_000;

export async function getPlayers(): Promise<{ players: PlexPlayer[]; error: string | null }> {
  try {
    const res = await fetch("/api/plex/players");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { players: [], error: (body as { error?: string }).error ?? "Couldn't list your devices." };
    }
    const body = (await res.json()) as { players?: PlexPlayer[] };
    return { players: body.players ?? [], error: null };
  } catch {
    return { players: [], error: "Couldn't reach the server." };
  }
}

export type PlaybackOutcome =
  | { status: "playing" }
  | { status: "failed"; message: string }
  /** Command sent, never confirmed, and the player has been stopped so
   *  nothing is left running unattended. */
  | { status: "gave-up" };

export async function playOnDevice(params: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  playerMachineIdentifier: string;
  onProgress?: (elapsedMs: number) => void;
}): Promise<PlaybackOutcome> {
  const sent = await postJson<{ sent: boolean; ratingKey: string }>("/api/plex/play", {
    tmdbId: params.tmdbId,
    mediaType: params.mediaType,
    playerMachineIdentifier: params.playerMachineIdentifier,
  });
  if (!sent.ok || !sent.data?.ratingKey) {
    return { status: "failed", message: sent.error ?? "Couldn't send that to your device." };
  }

  const ratingKey = sent.data.ratingKey;
  const startedAt = Date.now();

  while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    params.onProgress?.(Date.now() - startedAt);
    try {
      const res = await fetch(`/api/plex/play/status?ratingKey=${encodeURIComponent(ratingKey)}`);
      if (res.ok) {
        const body = (await res.json()) as { playing?: boolean };
        if (body.playing) return { status: "playing" };
      }
    } catch {
      // Transient — keep polling until the deadline.
    }
  }

  // Timed out. Do NOT just report failure: stop the device first, because
  // "unconfirmed" and "not playing" are not the same thing.
  await stopOnDevice(params.playerMachineIdentifier);
  return { status: "gave-up" };
}

export async function stopOnDevice(playerMachineIdentifier: string): Promise<boolean> {
  try {
    const res = await fetch("/api/plex/play", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerMachineIdentifier }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
