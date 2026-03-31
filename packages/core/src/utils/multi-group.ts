/**
 * FalkorDB multi-group routing — port of Python's handle_multiple_group_ids decorator.
 *
 * In FalkorDB, each group_id maps to a separate database/graph. When a method
 * receives multiple group_ids, we need to:
 * 1. Execute the operation concurrently for each group_id with a cloned driver
 * 2. Merge the results
 *
 * For Neo4j, group_id is just a property filter within a single database,
 * so this routing is not needed.
 */

import { GraphProviders } from '@graphiti/shared';
import type { GraphDriver } from '../contracts';
import type { SearchResults } from '../search/config';
import { mergeSearchResults } from '../search/config';
import { semaphoreGather } from './concurrency';
import { FalkorDriver } from '../driver/falkordb-driver';

/**
 * Check if the driver is FalkorDB and we have multiple group_ids that need routing.
 */
export function needsMultiGroupRouting(
  driver: GraphDriver,
  groupIds: string[] | null | undefined
): boolean {
  return (
    driver.provider === GraphProviders.FALKORDB &&
    Array.isArray(groupIds) &&
    groupIds.length > 1
  );
}

/**
 * Execute an async function for each group_id with a cloned FalkorDB driver,
 * then merge the results.
 *
 * This is the TypeScript equivalent of Python's @handle_multiple_group_ids decorator.
 *
 * @param driver - The FalkorDB driver to clone per group
 * @param groupIds - The group IDs to route across
 * @param fn - The async function to execute per group. Receives (clonedDriver, singleGroupIds).
 * @param maxCoroutines - Concurrency limit for parallel execution
 */
export async function executeWithMultiGroupRouting<T>(
  driver: GraphDriver,
  groupIds: string[],
  fn: (driver: GraphDriver, groupIds: string[]) => Promise<T>,
  maxCoroutines?: number | null
): Promise<T> {
  if (!(driver instanceof FalkorDriver)) {
    return fn(driver, groupIds);
  }

  const results = await semaphoreGather(
    groupIds.map(
      (gid) => async () => {
        const clonedDriver = driver.clone(gid);
        return fn(clonedDriver, [gid]);
      }
    ),
    maxCoroutines ?? 10
  );

  // Merge results based on type
  return mergeResults(results);
}

/**
 * Merge results from multiple group executions.
 * Handles SearchResults, arrays, tuples, and scalar values.
 */
function mergeResults<T>(results: T[]): T {
  if (results.length === 0) {
    return results as unknown as T;
  }

  const first = results[0];

  // SearchResults — use the dedicated merge function
  if (isSearchResults(first)) {
    return mergeSearchResults(results as unknown as SearchResults[]) as unknown as T;
  }

  // Arrays — flatten
  if (Array.isArray(first)) {
    const merged: unknown[] = [];
    for (const result of results) {
      merged.push(...(result as unknown as unknown[]));
    }
    return merged as unknown as T;
  }

  // Tuple-like objects with nodes/edges properties (e.g., buildCommunities result)
  if (
    first !== null &&
    typeof first === 'object' &&
    'nodes' in (first as Record<string, unknown>) &&
    'edges' in (first as Record<string, unknown>)
  ) {
    const merged: Record<string, unknown[]> = {};
    for (const key of Object.keys(first as Record<string, unknown>)) {
      merged[key] = [];
    }
    for (const result of results) {
      for (const key of Object.keys(result as Record<string, unknown>)) {
        const val = (result as Record<string, unknown>)[key];
        if (Array.isArray(val)) {
          (merged[key] as unknown[]).push(...val);
        }
      }
    }
    return merged as unknown as T;
  }

  // Default: return the array of results
  return results as unknown as T;
}

function isSearchResults(value: unknown): value is SearchResults {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    'edges' in obj &&
    'nodes' in obj &&
    'edge_reranker_scores' in obj &&
    'node_reranker_scores' in obj
  );
}
