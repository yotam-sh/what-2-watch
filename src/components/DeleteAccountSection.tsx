"use client";

// Account deletion — POST /api/account/delete (src/app/api/account/delete/route.ts).
// There's no password to re-verify any more (see that route's header) — the
// confirmation step is typing the account's own Plex username back, still
// making the irreversibility explicit before the request ever fires: since
// schema.ts cascades every table off users.id, everything — the Plex link,
// watch history, watchlist, all recommendation data — is gone for good the
// moment this succeeds. No "recover my account" path exists or can exist.
import { useState } from "react";
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
      <section className="border-t border-zinc-200 px-4 py-6 dark:border-zinc-800">
        <h2 className="mb-1 text-sm font-semibold text-red-600 dark:text-red-400">Danger zone</h2>
        <p className="mb-3 text-sm text-zinc-500">Permanently delete your account and all its data.</p>
        <button
          onClick={() => setExpanded(true)}
          className="tap-target rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 dark:border-red-900 dark:text-red-400"
        >
          Delete account
        </button>
      </section>
    );
  }

  return (
    <section className="border-t border-zinc-200 px-4 py-6 dark:border-zinc-800">
      <h2 className="mb-1 text-sm font-semibold text-red-600 dark:text-red-400">Delete your account</h2>
      <p className="mb-3 max-w-sm text-sm text-zinc-500">
        This deletes your account and everything tied to it — your Plex sign-in, Letterboxd link,
        watch history, watchlist, and all recommendation data — immediately and permanently. There is
        no undo.
      </p>
      <form onSubmit={handleDelete} className="flex max-w-xs flex-col gap-2">
        <label htmlFor="delete-confirm-username" className="text-sm font-medium">
          Type your Plex username (<span className="font-mono">{username}</span>) to confirm
        </label>
        <input
          id="delete-confirm-username"
          type="text"
          required
          value={confirmUsername}
          onChange={(e) => setConfirmUsername(e.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 text-base outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setExpanded(false);
              setConfirmUsername("");
              setError(null);
            }}
            className="tap-target flex-1 rounded-md border border-zinc-300 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !matches}
            className="tap-target flex-1 rounded-md bg-red-600 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Deleting..." : "Permanently delete"}
          </button>
        </div>
      </form>
    </section>
  );
}
