"use client";

// Renders each branch of src/lib/ui/emptyState.ts's DecideViewState as an
// actual first-class screen — never a blank roll, never a silent "no
// results" for what's actually a 502 or an expired session.
import Link from "next/link";
import type { DecideViewState } from "@/lib/ui/emptyState";
import { SpinnerIcon } from "./icons";

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      {children}
    </div>
  );
}

function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="tap-target rounded-md bg-brand px-5 py-2.5 font-medium text-brand-foreground">
      {children}
    </Link>
  );
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="tap-target rounded-md border border-zinc-300 px-5 py-2.5 font-medium dark:border-zinc-700"
    >
      {children}
    </button>
  );
}

export function DecideEmptyState({
  state,
  onSync,
  onClearFilters,
  syncing,
}: {
  state: DecideViewState;
  onSync: () => void;
  onClearFilters: () => void;
  syncing: boolean;
}) {
  switch (state.kind) {
    case "loading":
      return (
        <Wrap>
          <SpinnerIcon className="h-8 w-8 text-zinc-400" />
          <p className="text-zinc-500">Rolling...</p>
        </Wrap>
      );

    case "no-links":
      return (
        <Wrap>
          <h2 className="text-lg font-semibold">Nothing to roll yet</h2>
          <p className="max-w-xs text-zinc-500">
            Link your Plex or Letterboxd account in Settings so what-to-watch has real history to
            work from.
          </p>
          <PrimaryLink href="/settings">Go to Settings</PrimaryLink>
        </Wrap>
      );

    case "not-synced":
      return (
        <Wrap>
          <h2 className="text-lg font-semibold">
            {state.sources.map((s) => (s === "plex" ? "Plex" : "Letterboxd")).join(" and ")} linked, not synced
            yet
          </h2>
          <p className="max-w-xs text-zinc-500">
            Run a sync to pull your watch history before we can pick something for you.
          </p>
          <SecondaryButton onClick={onSync}>{syncing ? "Syncing..." : "Sync now"}</SecondaryButton>
        </Wrap>
      );

    case "plex-unreachable":
      return (
        <Wrap>
          <h2 className="text-lg font-semibold">Can&apos;t reach your Plex server</h2>
          <p className="max-w-xs text-zinc-500">{state.message}</p>
          <p className="max-w-xs text-xs text-zinc-400">
            This usually means your server is offline or unreachable from here — not that
            anything is wrong with your account.
          </p>
          <SecondaryButton onClick={onSync}>Try again</SecondaryButton>
        </Wrap>
      );

    case "session-expired":
      return (
        <Wrap>
          <h2 className="text-lg font-semibold">Your session expired</h2>
          <p className="max-w-xs text-zinc-500">
            This can happen after a server restart — per-user encryption means the server can only
            decrypt your Plex token while you&apos;re actively logged in. Log in again to continue.
          </p>
          <PrimaryLink href="/login">Log in again</PrimaryLink>
        </Wrap>
      );

    case "server-error":
      return (
        <Wrap>
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="max-w-xs text-zinc-500">{state.message}</p>
          <SecondaryButton onClick={onSync}>Try again</SecondaryButton>
        </Wrap>
      );

    case "no-candidates":
      return (
        <Wrap>
          <h2 className="text-lg font-semibold">Nothing matched</h2>
          <p className="max-w-xs text-zinc-500">
            {state.activeFilters.length > 0
              ? `Nothing in your library matches ${state.activeFilters.join(", ")}. Try loosening a filter.`
              : "Nothing in your library qualified for this mode yet."}
          </p>
          {state.activeFilters.length > 0 && (
            <SecondaryButton onClick={onClearFilters}>Clear filters</SecondaryButton>
          )}
        </Wrap>
      );

    case "results":
      return null;
  }
}
