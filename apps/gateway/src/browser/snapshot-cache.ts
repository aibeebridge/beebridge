import { createHash } from "node:crypto";

interface CacheEntry {
  snapshot: string;
  url: string;
  hash: string;
  cachedAt: number;
}

export class SnapshotCache {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(private ttlMs: number = 5 * 60 * 1000) {}

  private hashContent(snapshot: string): string {
    return createHash("md5").update(snapshot).digest("hex").slice(0, 12);
  }

  get(url: string): CacheEntry | null {
    const entry = this.cache.get(url);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(url);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry;
  }

  put(url: string, snapshot: string): CacheEntry {
    const entry: CacheEntry = {
      snapshot,
      url,
      hash: this.hashContent(snapshot),
      cachedAt: Date.now(),
    };
    this.cache.set(url, entry);
    return entry;
  }

  /** Returns true if the new snapshot differs from cached version */
  hasChanged(url: string, newSnapshot: string): boolean {
    const cached = this.cache.get(url);
    if (!cached) return true;
    return this.hashContent(newSnapshot) !== cached.hash;
  }

  invalidate(url: string): void {
    this.cache.delete(url);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }
}
