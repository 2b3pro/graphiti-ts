/**
 * LLM response cache — port of Python's graphiti_core/llm_client/cache.py.
 *
 * In-memory cache for LLM responses. Python uses SQLite; TS uses a Map
 * since the cache is ephemeral within a session and avoids native deps.
 */

export class LLMCache {
  private cache: Map<string, string>;
  private readonly maxSize: number;

  constructor(maxSize = 10000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Retrieve a cached response by key, or null if not found.
   */
  get(key: string): Record<string, unknown> | null {
    const value = this.cache.get(key);
    if (value === undefined) return null;

    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Store a response in the cache. Only JSON-serializable data is stored.
   */
  set(key: string, value: Record<string, unknown>): void {
    try {
      const serialized = JSON.stringify(value);

      // Evict oldest entries if at capacity
      if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) {
          this.cache.delete(firstKey);
        }
      }

      this.cache.set(key, serialized);
    } catch {
      // Skip non-serializable values silently
    }
  }

  /**
   * Clear all cached entries.
   */
  close(): void {
    this.cache.clear();
  }

  /**
   * Number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}
