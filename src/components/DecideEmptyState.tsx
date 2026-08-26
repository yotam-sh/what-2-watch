"use client";

// Renders each branch of src/lib/ui/emptyState.ts's DecideViewState as an
// actual first-class screen — never a blank roll, never a silent "no
// results" for what's actually a 502 or an expired session.
//
// Each branch gets its own glyph, and the glyph is doing real work: it's the
// fastest way to tell "your server is unreachable" apart from "nothing
// matched your filters" at a glance, which matters because those two look
// identical as a wall of text and have completely different fixes.
import Link from "next/link";
import { Link2Off, LogOut, RefreshCw, SearchX, ServerOff, TriangleAlert } from "lucide-react";
import { buttonClasses, Button } from "@/components/ui/Button";
import type { DecideViewState } from "@/lib/ui/emptyState";
import { SpinnerIcon } from "./icons";

// overflow-y-auto, not overflow-hidden: the Decide screen clips its own
// overflow on a phone (it's a static swipe surface, not a document), but an
// empty state is prose — a long message on a short phone must still be
// readable, so it scrolls inside this box rather than being cut off. The
// page itself still doesn't move.
function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-8 text-center sm:py-16">
      {children}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-heading">{children}</h2>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="max-w-xs text-[13px] text-secondary">{children}</p>;
}

function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  // A styled <Link>, not a <Button>: these pages are Server Components in
  // places, and navigation belongs to the router, not to an onClick.
  return (
    <Link href={href} className={buttonClasses({ variant: "primary" })}>
      {children}
    </Link>
  );
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <Button onClick={onClick} variant="secondary">
      {children}
    </Button>
  );
}

const GLYPH = "h-[22px] w-[22px] text-muted";

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
          {/* Lucide's LoaderCircle is a static glyph — the spin comes from
              here now, not from the icon component. */}
          <SpinnerIcon className={`${GLYPH} animate-spin`} strokeWidth={2} aria-hidden="true" />
          <Body>Rolling...</Body>
        </Wrap>
      );

    case "no-links":
      return (
        <Wrap>
          <Link2Off className={GLYPH} strokeWidth={2} aria-hidden="true" />
          <Heading>Nothing to roll yet</Heading>
          <Body>
            Link your Plex or Letterboxd account in Settings so what2watch has real history to
            work from.
          </Body>
          <PrimaryLink href="/settings">Go to Settings</PrimaryLink>
        </Wrap>
      );

    case "not-synced":
      return (
        <Wrap>
          <RefreshCw className={GLYPH} strokeWidth={2} aria-hidden="true" />
          <Heading>
            {state.sources.map((s) => (s === "plex" ? "Plex" : "Letterboxd")).join(" and ")} linked, not synced
            yet
          </Heading>
          <Body>Run a sync to pull your watch history before we can pick something for you.</Body>
          <SecondaryButton onClick={onSync}>{syncing ? "Syncing..." : "Sync now"}</SecondaryButton>
        </Wrap>
      );

    case "plex-unreachable":
      return (
        <Wrap>
          <ServerOff className={GLYPH} strokeWidth={2} aria-hidden="true" />
          <Heading>Can&apos;t reach your Plex server</Heading>
          <Body>{state.message}</Body>
          <p className="max-w-xs text-[11px] text-muted">
            This usually means your server is offline or unreachable from here — not that
            anything is wrong with your account.
          </p>
          <SecondaryButton onClick={onSync}>Try again</SecondaryButton>
        </Wrap>
      );

    case "session-expired":
      return (
        <Wrap>
          <LogOut className={GLYPH} strokeWidth={2} aria-hidden="true" />
          <Heading>Your session expired</Heading>
          <Body>Sign in with Plex again to continue.</Body>
          <PrimaryLink href="/">Sign in again</PrimaryLink>
        </Wrap>
      );

    case "server-error":
      return (
        <Wrap>
          {/* Amber, not muted: this one is a fault, and the semantic hue is
              the signal that it isn't just an empty result. */}
          <TriangleAlert className="h-[22px] w-[22px] text-warning" strokeWidth={2} aria-hidden="true" />
          <Heading>Something went wrong</Heading>
          <Body>{state.message}</Body>
          <SecondaryButton onClick={onSync}>Try again</SecondaryButton>
        </Wrap>
      );

    case "no-candidates":
      return (
        <Wrap>
          <SearchX className={GLYPH} strokeWidth={2} aria-hidden="true" />
          <Heading>Nothing matched</Heading>
          <Body>
            {state.activeFilters.length > 0
              ? `Nothing in your library matches ${state.activeFilters.join(", ")}. Try loosening a filter.`
              : "Nothing in your library qualified for this mode yet."}
          </Body>
          {state.activeFilters.length > 0 && (
            <SecondaryButton onClick={onClearFilters}>Clear filters</SecondaryButton>
          )}
        </Wrap>
      );

    case "results":
      return null;
  }
}
