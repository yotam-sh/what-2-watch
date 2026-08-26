// Static offline fallback — precached by sw.js at install time and served
// for any navigation that fails while the network is down. Deliberately has
// no data fetching of any kind (it must render from cache alone).
import { WifiOff } from "lucide-react";

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12 text-center">
      <div className="aurora aurora-void" aria-hidden="true" />
      <WifiOff className="mb-4 h-9 w-9 text-muted" strokeWidth={2} aria-hidden="true" />
      <h1 className="mb-2 font-display text-[22px] font-semibold tracking-[-0.02em] text-heading">
        You&apos;re offline
      </h1>
      <p className="max-w-sm text-[13px] text-secondary">
        what2watch needs a connection to pull your watch history and pick something. Once
        you&apos;re back online, reopen the app and it&apos;ll pick up where it left off.
      </p>
    </main>
  );
}
