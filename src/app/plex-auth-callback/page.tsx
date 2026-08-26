"use client";

// Where the *popup* window lands after the user authorises at app.plex.tv
// (see /api/auth/plex/start's forwardUrl). This page must render without a
// session — it loads in the popup before any session cookie exists there;
// the original tab is the one polling /api/auth/plex/poll and is what
// actually establishes the session. Do NOT wrap this in requireUser()/
// getOptionalUser() or redirect unauthenticated visitors.
//
// Job: tell the opener we're done (a hint to poll immediately rather than
// wait for the next interval tick — see isTrustedPlexAuthCompleteMessage in
// src/lib/ui/pinFlow.ts for why that message alone can never authenticate
// anyone), then close this window. window.close() only works on a window
// that script opened (PlexSignInCard.tsx's window.open()) — if this page
// was instead opened as a normal browser tab (e.g. the user copy-pasted the
// link, or the popup was blocked and they used the manual fallback link),
// close() silently no-ops, so a visible fallback message is mandatory: never
// leave this page blank.
import { useEffect, useState } from "react";
import { PLEX_AUTH_COMPLETE_MESSAGE_TYPE } from "@/lib/ui/pinFlow";

export default function PlexAuthCallbackPage() {
  const [closeFailed, setCloseFailed] = useState(false);

  useEffect(() => {
    try {
      window.opener?.postMessage({ type: PLEX_AUTH_COMPLETE_MESSAGE_TYPE }, window.location.origin);
    } catch {
      // Opener gone, or a cross-origin/COOP edge case — the original tab's
      // own poll loop is the fallback regardless of whether this message
      // makes it through.
    }

    window.close();

    // window.close() is synchronous when it works, but browsers that refuse
    // it (this wasn't a script-opened window) just no-op rather than
    // throwing, so there's nothing to catch — only a timer can tell us it
    // didn't work. Long enough to not flash the fallback text on a normal
    // close, short enough that a real failure still gets a visible message
    // promptly.
    const timer = setTimeout(() => setCloseFailed(true), 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-void px-6 py-12 text-center">
      <p className="text-body" role="status">
        {closeFailed
          ? "Authorised — you can close this window and return to the app."
          : "Authorised. Closing this window..."}
      </p>
    </main>
  );
}
