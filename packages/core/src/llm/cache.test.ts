import { describe, expect, test } from 'bun:test';

import { LLMCache } from './cache';

describe('LLMCache', () => {
  test('returns null for cache miss', () => {
    const cache = new LLMCache();
    expect(cache.get('nonexistent')).toBeNull();
  });

  test('stores and retrieves a value', () => {
    const cache = new LLMCache();
    const value = { entities: ['Alice', 'Bob'] };
    cache.set('key1', value);
    expect(cache.get('key1')).toEqual(value);
  });

  test('stores values as JSON (deep copy semantics)', () => {
    const cache = new LLMCache();
    const value = { count: 1 };
    cache.set('key1', value);
    value.count = 999;
    // Retrieved value should reflect the original stored value
    expect(cache.get('key1')).toEqual({ count: 1 });
  });

  test('overwrites existing key', () => {
    const cache = new LLMCache();
    cache.set('key1', { v: 1 });
    cache.set('key1', { v: 2 });
    expect(cache.get('key1')).toEqual({ v: 2 });
    expect(cache.size).toBe(1);
  });

  test('evicts oldest entry when at capacity', () => {
    const cache = new LLMCache(3);
    cache.set('a', { v: 1 });
    cache.set('b', { v: 2 });
    cache.set('c', { v: 3 });
    // At capacity — adding new key should evict oldest ('a')
    cache.set('d', { v: 4 });
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toEqual({ v: 2 });
    expect(cache.get('d')).toEqual({ v: 4 });
    expect(cache.size).toBe(3);
  });

  test('does not evict when overwriting existing key at capacity', () => {
    const cache = new LLMCache(2);
    cache.set('a', { v: 1 });
    cache.set('b', { v: 2 });
    // Overwriting 'a' should not evict
    cache.set('a', { v: 10 });
    expect(cache.get('a')).toEqual({ v: 10 });
    expect(cache.get('b')).toEqual({ v: 2 });
    expect(cache.size).toBe(2);
  });

  test('close() clears all entries', () => {
    const cache = new LLMCache();
    cache.set('a', { v: 1 });
    cache.set('b', { v: 2 });
    cache.close();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeNull();
  });

  test('size returns correct count', () => {
    const cache = new LLMCache();
    expect(cache.size).toBe(0);
    cache.set('a', { v: 1 });
    expect(cache.size).toBe(1);
    cache.set('b', { v: 2 });
    expect(cache.size).toBe(2);
  });

  test('handles non-JSON-serializable values gracefully', () => {
    const cache = new LLMCache();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    // Should not throw — silently skips
    cache.set('circular', circular);
    expect(cache.get('circular')).toBeNull();
  });

  test('returns null if stored value is corrupt JSON', () => {
    const cache = new LLMCache();
    // Directly set via internal map to simulate corruption
    (cache as any).cache.set('bad', 'not{json');
    expect(cache.get('bad')).toBeNull();
  });
});
