"use client";

// Account deletion — POST /api/account/delete (src/app/api/account/delete/route.ts).
// Requires re-entering the password (see that route's header for why) and
// makes the irreversibility explicit before the request ever fires: with
// per-user-key encryption, the Plex token — and everything else, since
// schema.ts cascades every table off users.id — is gone for good the moment
// this succeeds. No "recover my account" path exists or can exist here.
import { useState } from "react";
import { postJson } from "@/lib/client/http";

export function DeleteAccountSection() {
  const [expanded, setExpanded] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await postJson("/api/account/delete", { password });
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
        This deletes your account and everything tied to it — Plex and Letterboxd links, watch
        history, watchlist, and all recommendation data — immediately and permanently. Because your
        Plex token is encrypted with a key derived from your password, it cannot be recovered once
        this account is gone. There is no undo.
      </p>
      <form onSubmit={handleDelete} className="flex max-w-xs flex-col gap-2">
        <label htmlFor="delete-password" className="text-sm font-medium">
          Confirm your password
        </label>
        <input
          id="delete-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 text-base outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setExpanded(false);
              setPassword("");
              setError(null);
            }}
            className="tap-target flex-1 rounded-md border border-zinc-300 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="tap-target flex-1 rounded-md bg-red-600 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Deleting..." : "Permanently delete"}
          </button>
        </div>
      </form>
    </section>
  );
}
