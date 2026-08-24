"use client";

// Shared hook for GET /api/plex/link/status + GET /api/letterboxd/status —
// both DecideScreen (to pick the right empty state) and SettingsScreen (to
// render link/sync UI) need the same data, so it's fetched in one place.
import { useCallback, useEffect, useState } from "react";
import { getJson } from "./http";

export type PlexLinkStatusResponse =
  | { linked: false }
  | {
      linked: true;
      machineIdentifier: string | null;
      hasConnection: boolean;
      connectionCheckedAt: string | null;
      keyScope: "user" | "server";
    };

export type LetterboxdLinkStatusResponse =
  | { linked: false }
  | {
      linked: true;
      username: string;
      lastPolledAt: string | null;
      lastRunAt: string | null;
      lastError: string | null;
    };

export interface LinkStatus {
  plex: PlexLinkStatusResponse | null;
  letterboxd: LetterboxdLinkStatusResponse | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useLinkStatus(): LinkStatus {
  const [plex, setPlex] = useState<PlexLinkStatusResponse | null>(null);
  const [letterboxd, setLetterboxd] = useState<LetterboxdLinkStatusResponse | null>(null);
  // Starts true rather than being set true at the top of refetch(): the
  // mount effect below calls refetch() synchronously, and a setState call
  // that's the first thing to run inside an effect (even indirectly, via a
  // function it calls before that function's first `await`) triggers React's
  // "avoid setState synchronously in an effect" lint rule. Defaulting the
  // state itself to `true` gets the same "show loading on mount" behavior
  // without that synchronous call.
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const [p, l] = await Promise.all([
      getJson<PlexLinkStatusResponse>("/api/plex/link/status"),
      getJson<LetterboxdLinkStatusResponse>("/api/letterboxd/status"),
    ]);
    if (p.data) setPlex(p.data);
    if (l.data) setLetterboxd(l.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Standard "fetch on mount" — react-hooks/set-state-in-effect flags any
    // effect that synchronously calls a function which *eventually* calls
    // setState, even one that only does so after an `await` (the state
    // updates here all happen strictly in refetch()'s post-await
    // continuation, never synchronously during this effect's own
    // execution). There's no Suspense/data-fetching-library layer in this
    // app to hand this off to, so this is the correct shape for it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetch();
  }, [refetch]);

  return { plex, letterboxd, loading, refetch };
}
