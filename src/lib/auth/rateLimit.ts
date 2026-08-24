// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter.
//
// Good enough at this app's scale (single process, small self-hosted user
// base) per the plan — no Redis needed. NOT shared across processes: if
// this app is ever horizontally scaled, this must move to a shared store.
// Each call site (signup, login, ...) instantiates its own limiter so a
// burst against one endpoint can't lock out the other, per the plan's
// "rate-limit signup and login independently".
// ---------------------------------------------------------------------------

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true and records a hit if `key` is still within its limit for
   *  the current window; returns false without recording anything if the
   *  caller is already at the limit. */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.limit) {
      this.hits.set(key, timestamps); // still prune, even on reject
      return false;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }
}
