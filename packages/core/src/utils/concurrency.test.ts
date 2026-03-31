import { describe, expect, test } from 'bun:test';

import { semaphoreGather } from './concurrency';

describe('semaphoreGather', () => {
  test('returns results in input order', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c')
    ];
    const results = await semaphoreGather(tasks);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  test('handles empty task array', async () => {
    const results = await semaphoreGather([]);
    expect(results).toEqual([]);
  });

  test('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const tasks = Array.from({ length: 20 }, (_, i) => async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      currentConcurrent--;
      return i;
    });

    const results = await semaphoreGather(tasks, 3);

    // Results should be in order
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
    // Max concurrent should not exceed limit
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  test('uses default concurrency of 10', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const tasks = Array.from({ length: 30 }, (_, i) => async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      await new Promise((r) => setTimeout(r, 5));
      currentConcurrent--;
      return i;
    });

    await semaphoreGather(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(10);
  });

  test('propagates errors from tasks', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error('task failed')),
      () => Promise.resolve(3)
    ];

    await expect(semaphoreGather(tasks)).rejects.toThrow('task failed');
  });

  test('handles single task', async () => {
    const results = await semaphoreGather([() => Promise.resolve(42)]);
    expect(results).toEqual([42]);
  });

  test('handles concurrency larger than task count', async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2)];
    const results = await semaphoreGather(tasks, 100);
    expect(results).toEqual([1, 2]);
  });
});
