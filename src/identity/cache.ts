/**
 * A size-capped TTL cache that serializes to plain `[key, {v, at}]` entries
 * (storage-friendly, and no prototype surprises from handle-shaped keys).
 */
export class EntryCache<V> {
  private map: Map<string, { v: V; at: number }>;

  constructor(entries: [string, { v: V; at: number }][] = [], private max = 2000) {
    this.map = new Map(Array.isArray(entries) ? entries : []);
  }

  /** `ttl` may depend on the value, e.g. shorter for failures. */
  get(key: string, now: number, ttl: number | ((v: V) => number)): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at >= (typeof ttl === 'number' ? ttl : ttl(hit.v))) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, v: V, now: number) {
    this.map.delete(key);
    this.map.set(key, { v, at: now });
    // Map keeps insertion order, so the first keys are the oldest
    for (const k of this.map.keys()) {
      if (this.map.size <= this.max) break;
      this.map.delete(k);
    }
  }

  delete(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  entries(): [string, { v: V; at: number }][] {
    return [...this.map];
  }
}
