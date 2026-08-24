// Static offline fallback — precached by sw.js at install time and served
// for any navigation that fails while the network is down. Deliberately has
// no data fetching of any kind (it must render from cache alone).
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12 text-center">
      <h1 className="text-xl font-semibold mb-2">You&apos;re offline</h1>
      <p className="text-zinc-500 max-w-sm">
        what-to-watch needs a connection to pull your watch history and pick something. Once
        you&apos;re back online, reopen the app and it&apos;ll pick up where it left off.
      </p>
    </main>
  );
}
