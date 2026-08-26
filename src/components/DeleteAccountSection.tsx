"use client";

// Account deletion — POST /api/account/delete (src/app/api/account/delete/route.ts).
// There's no password to re-verify any more (see that route's header) — the
// confirmation step is typing the account's own Plex username back, still
// making the irreversibility explicit before the request ever fires: since
// schema.ts cascades every table off users.id, everything — the Plex link,
// watch history, watchlist, all recommendation data — is gone for good the
// moment this succeeds. No "recover my account" path exists or can exist.
//
// Two-step by design: the outlined `danger` button only reveals the form.
// The solid red button is the one that actually deletes, and it stays
// disabled until the typed username matches.
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { postJson } from "@/lib/client/http";

export function DeleteAccountSection({ username }: { username: string }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmUsername, setConfirmUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const matches = confirmUsername.trim() === username;

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setSubmitting(true);
    setError(null);
    const result = await postJson("/api/account/delete", { confirmUsername });
    if (!result.ok) {
      setError(result.error ?? "Could not delete your account.");
      setSubmitting(false);
      return;
    }
    // Account and session are gone server-side — a hard navigation is the
    // simplest way to guarantee no stale client state survives.
    window.location.href = "/";
  }

  if (!expanded) {
    return (
      <section className="rounded-[12px] border border-negative/40 bg-card px-5 py-5 shadow-comet-md">
        <h2 className="mb-1 text-[13px] font-semibold text-negative">Danger zone</h2>
        <p className="mb-3 text-[13px] text-secondary">Permanently delete your account and all its data.</p>
        <Button onClick={() => setExpanded(true)} variant="danger">
          Delete account
        </Button>
      </section>
    );
  }

  return (
    <section className="rounded-[12px] border border-negative/40 bg-card px-5 py-5 shadow-comet-md">
      <h2 className="mb-1 text-[13px] font-semibold text-negative">Delete your account</h2>
      <p className="mb-3 max-w-sm text-[13px] text-secondary">
        This deletes your account and everything tied to it — your Plex sign-in, Letterboxd link,
        watch history, watchlist, and all recommendation data — immediately and permanently. There is
        no undo.
      </p>
      <form onSubmit={handleDelete} className="flex max-w-xs flex-col gap-2">
        <label htmlFor="delete-confirm-username" className="text-[13px] font-medium text-body">
          Type your Plex username (<span className="font-mono text-accent">{username}</span>) to confirm
        </label>
        <input
          id="delete-confirm-username"
          type="text"
          required
          value={confirmUsername}
          onChange={(e) => setConfirmUsername(e.target.value)}
          // text-base (16px) so iOS Safari doesn't zoom the page on focus.
          className="h-[38px] rounded-[10px] border border-line bg-inset px-3 font-mono text-base text-body outline-none transition-colors duration-[180ms] ease-out placeholder:text-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        />
        {error && <p className="text-[13px] text-negative">{error}</p>}
        <div className="mt-1 flex gap-2">
          <Button
            onClick={() => {
              setExpanded(false);
              setConfirmUsername("");
              setError(null);
            }}
            variant="secondary"
            className="flex-1"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !matches} variant="danger-solid" className="flex-1">
            {submitting ? "Deleting..." : "Permanently delete"}
          </Button>
        </div>
      </form>
    </section>
  );
}
