/** Token bucket: `burst` tokens, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private burst: number, private perSecond: number, now = Date.now()) {
    this.tokens = burst;
    this.last = now;
  }

  /** Takes up to `n` tokens and returns how many were granted. */
  take(n: number, now = Date.now()): number {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    const granted = Math.max(0, Math.min(n, Math.floor(this.tokens)));
    this.tokens -= granted;
    return granted;
  }
}

/** Handles waiting for a lookup: deduplicated, oldest dropped past `max` (they re-queue if seen again). */
export class PendingQueue {
  private items = new Set<string>();

  constructor(private max = 500) {}

  add(handles: Iterable<string>) {
    for (const h of handles) {
      this.items.delete(h);
      this.items.add(h);
    }
    for (const h of this.items) {
      if (this.items.size <= this.max) break;
      this.items.delete(h);
    }
  }

  take(n: number): string[] {
    const out = [...this.items].slice(0, n);
    for (const h of out) this.items.delete(h);
    return out;
  }

  get size() {
    return this.items.size;
  }
}
