"use client";

// The "Play on …" control on the Decide verdict screen.
//
// Additive by design: everything here can fail, be empty, or be switched off
// entirely and the verdict screen still works. Picking a film is the app's
// job; starting it on a television is a convenience layered on top, so a
// household with no Plex client awake sees a quiet hint, never an error.
//
// Three behaviours worth knowing before editing:
//   - Starting takes ~8 seconds to confirm and cannot be confirmed any
//     faster (see src/lib/client/plexPlayback.ts). Hence the explicit
//     "Starting…" state rather than an optimistic flip to "Playing".
//   - A play command SILENTLY REPLACES whatever the device is already
//     playing. Plex provides no guard at all, so the confirm step below is
//     the only thing standing between a tap here and hijacking someone
//     else's film in the next room.
//   - Once something is playing, Stop must stay reachable. Leaving a stream
//     running unattended eventually records a watch event for a film nobody
//     watched, which corrupts the recommendations.
import { useCallback, useEffect, useRef, useState } from "react";
import { Cast, CircleStop, LoaderCircle, MonitorPlay, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { getPlayers, playOnDevice, stopOnDevice, type PlexPlayer } from "@/lib/client/plexPlayback";

type Phase =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "ready" }
  | { kind: "confirm-takeover"; player: PlexPlayer }
  | { kind: "starting"; player: PlexPlayer }
  | { kind: "playing"; player: PlexPlayer }
  | { kind: "error"; message: string };

export function PlayOnDevice({
  tmdbId,
  mediaType,
  title,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
}) {
  const [players, setPlayers] = useState<PlexPlayer[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    getPlayers().then(({ players: found }) => {
      if (!mounted.current) return;
      setPlayers(found);
      setPhase(found.length === 0 ? { kind: "none" } : { kind: "ready" });
    });
  }, []);

  const start = useCallback(
    async (player: PlexPlayer) => {
      setPhase({ kind: "starting", player });
      const outcome = await playOnDevice({
        tmdbId,
        mediaType,
        playerMachineIdentifier: player.machineIdentifier,
      });
      if (!mounted.current) return;
      if (outcome.status === "playing") setPhase({ kind: "playing", player });
      else if (outcome.status === "gave-up")
        setPhase({
          kind: "error",
          message: `Sent it to ${player.name}, but nothing started within 20 seconds. The device has been stopped — check the TV.`,
        });
      else setPhase({ kind: "error", message: outcome.message });
    },
    [tmdbId, mediaType],
  );

  /** Anything already on this device gets a confirm first — Plex won't ask. */
  const request = useCallback(
    (player: PlexPlayer) => {
      if (player.busy) setPhase({ kind: "confirm-takeover", player });
      else void start(player);
    },
    [start],
  );

  const stop = useCallback(async (player: PlexPlayer) => {
    await stopOnDevice(player.machineIdentifier);
    if (mounted.current) setPhase({ kind: "ready" });
  }, []);

  if (phase.kind === "loading") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
        Looking for your devices...
      </p>
    );
  }

  // Not an error state: no device awake is the normal case, and the cause is
  // almost always the one named here. That toggle cost three rounds of
  // debugging to find, so it belongs in the UI rather than in a wiki.
  if (phase.kind === "none") {
    return (
      <p className="max-w-xs text-[11px] leading-relaxed text-muted">
        No Plex player is awake. Open Plex on your TV or streamer — and check{" "}
        <span className="text-secondary">Advertise as player</span> is on in its settings.
      </p>
    );
  }

  if (phase.kind === "confirm-takeover") {
    const { player } = phase;
    return (
      <div className="flex w-full max-w-xs flex-col gap-2 rounded-[10px] border border-[color:var(--warning)]/40 bg-inset p-3">
        <p className="flex items-start gap-2 text-[13px] text-body">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" strokeWidth={2} aria-hidden="true" />
          <span>
            <span className="font-semibold">{player.busy?.title}</span> is already playing on {player.name}.
            Take over? Their place will be saved.
          </span>
        </p>
        <div className="flex gap-2">
          <Button onClick={() => setPhase({ kind: "ready" })} variant="secondary" size="sm" className="flex-1">
            Cancel
          </Button>
          <Button onClick={() => void start(player)} variant="primary" size="sm" className="flex-1">
            Take over
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "starting") {
    return (
      <p className="flex items-center gap-2 text-[13px] text-secondary">
        <LoaderCircle className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
        Starting {title} on {phase.player.name}...
      </p>
    );
  }

  if (phase.kind === "playing") {
    return (
      <div className="flex flex-col items-center gap-2">
        <p className="flex items-center gap-2 text-[13px] text-positive">
          <MonitorPlay className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Playing on {phase.player.name}
        </p>
        {/* Stop stays reachable for as long as we know something is running. */}
        <Button onClick={() => void stop(phase.player)} variant="secondary" size="sm">
          <CircleStop className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          Stop
        </Button>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-2">
        <p className="max-w-xs text-center text-[13px] text-negative">{phase.message}</p>
        <Button onClick={() => setPhase({ kind: "ready" })} variant="secondary" size="sm">
          Try again
        </Button>
      </div>
    );
  }

  // ready — one device needs no picker, matching the Plex server picker's
  // "don't make someone choose from a list of one" rule in Settings.
  if (players.length === 1) {
    const only = players[0]!;
    return (
      <Button onClick={() => request(only)} variant="secondary">
        <Cast className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
        Play on {only.name}
      </Button>
    );
  }

  return (
    <div className="flex w-full max-w-xs flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary">Play on</p>
      {players.map((p) => (
        <Button key={p.machineIdentifier} onClick={() => request(p)} variant="secondary" className="justify-between">
          <span className="flex items-center gap-2 truncate">
            <Cast className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
            {p.name}
          </span>
          {p.busy && <span className="shrink-0 text-[11px] text-warning">busy</span>}
        </Button>
      ))}
    </div>
  );
}
