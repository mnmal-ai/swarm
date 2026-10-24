/**
 * Global rate limit gate. When any component detects a rate limit,
 * the gate closes and all pending dispatch waits until the reset time.
 */
export class RateLimitGate {
  private resetAt: number = 0;
  private waiters: Array<() => void> = [];

  /** Is the gate currently closed (rate limited)? */
  isLimited(): boolean {
    return Date.now() < this.resetAt;
  }

  /** Close the gate until the given reset time. */
  trigger(resetAtMs: number, waitMs: number): void {
    const newResetAt = Math.max(resetAtMs, Date.now() + waitMs);
    if (newResetAt > this.resetAt) {
      this.resetAt = newResetAt;
    }
  }

  /** Wait until the gate opens. Returns immediately if not limited. */
  async wait(): Promise<void> {
    if (!this.isLimited()) return;
    const remaining = this.resetAt - Date.now();
    if (remaining <= 0) return;
    return new Promise(resolve => {
      // The cleanup closure removes itself from the waiters array when it runs,
      // whether it's invoked by the timer or by reset(). This prevents stale
      // closures from accumulating over many rate-limit events.
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        // setTimeout fires on libuv's monotonic clock; isLimited() checks
        // Date.now() (wall clock). The two can disagree by a millisecond or
        // two under load, so the timer can fire while isLimited() still
        // returns true. Re-arm against the remaining wall-clock delta in
        // that case so wait() never resolves while the gate is still closed.
        const stillRemaining = this.resetAt - Date.now();
        if (stillRemaining > 0) {
          timer = setTimeout(cleanup, stillRemaining);
          return;
        }
        clearTimeout(timer);
        const idx = this.waiters.indexOf(cleanup);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve();
      };
      timer = setTimeout(cleanup, remaining);
      this.waiters.push(cleanup);
    });
  }

  /** Get milliseconds until gate opens. */
  remainingMs(): number {
    return Math.max(0, this.resetAt - Date.now());
  }

  /** Force open the gate (e.g., for shutdown). */
  reset(): void {
    this.resetAt = 0;
    for (const resolve of this.waiters) resolve();
    this.waiters = [];
  }
}
