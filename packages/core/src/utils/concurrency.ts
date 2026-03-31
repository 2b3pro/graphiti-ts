/**
 * Concurrency helpers — port of Python's semaphore_gather().
 */

/**
 * Execute async functions with bounded concurrency.
 * Port of Python's semaphore_gather().
 *
 * @param tasks - Array of async functions to execute
 * @param maxConcurrency - Maximum number of concurrent executions (default: 10)
 * @returns Array of results in the same order as input tasks
 */
export async function semaphoreGather<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency = 10
): Promise<T[]> {
  if (tasks.length === 0) return [];

  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await tasks[currentIndex]!();
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, tasks.length) },
    () => runNext()
  );

  await Promise.all(workers);
  return results;
}
