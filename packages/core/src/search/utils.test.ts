import { describe, expect, test } from 'bun:test';

import type { GraphDriver } from '../contracts';

import {
  getMentionedNodes,
  getRelevantEdges,
  getRelevantNodes,
  getEdgeInvalidationCandidates
} from './utils';

// ---------------------------------------------------------------------------
// Mock driver
// ---------------------------------------------------------------------------

function makeMockDriver(records: Record<string, unknown>[] = []): GraphDriver {
  return {
    provider: 'mock',
    default_group_id: 'g1',
    database: 'test',
    session: () => ({ close: async () => {}, executeQuery: async () => ({ records }) }),
    transaction: () => ({
      run: async () => ({ records }),
      commit: async () => {},
      rollback: async () => {}
    }),
    close: async () => {},
    deleteAllIndexes: async () => {},
    buildIndicesAndConstraints: async () => {},
    executeQuery: async () => ({ records })
  } as any;
}

// ---------------------------------------------------------------------------
// getMentionedNodes
// ---------------------------------------------------------------------------

describe('getMentionedNodes', () => {
  test('returns empty array for empty episodes', async () => {
    const driver = makeMockDriver();
    const result = await getMentionedNodes(driver, []);
    expect(result).toEqual([]);
  });

  test('returns mapped entity nodes from query results', async () => {
    const records = [
      {
        uuid: 'n1',
        name: 'Alice',
        group_id: 'g1',
        labels: ['Entity', 'Person'],
        created_at: '2024-01-15T00:00:00Z',
        name_embedding: null,
        summary: 'A person',
        attributes: null
      }
    ];
    const driver = makeMockDriver(records);
    const episodes = [
      {
        uuid: 'ep1',
        name: 'ep1',
        group_id: 'g1',
        labels: ['Episodic'],
        created_at: new Date(),
        source: 'message' as const,
        source_description: 'test',
        content: 'Hello'
      }
    ];

    const result = await getMentionedNodes(driver, episodes);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Alice');
    expect(result[0]!.uuid).toBe('n1');
  });
});

// ---------------------------------------------------------------------------
// getRelevantEdges
// ---------------------------------------------------------------------------

describe('getRelevantEdges', () => {
  test('returns empty array for empty node UUIDs', async () => {
    const driver = makeMockDriver();
    const result = await getRelevantEdges(driver, []);
    expect(result).toEqual([]);
  });

  test('returns mapped edges from query results', async () => {
    const records = [
      {
        uuid: 'e1',
        group_id: 'g1',
        source_node_uuid: 'n1',
        target_node_uuid: 'n2',
        created_at: '2024-01-15T00:00:00Z',
        name: 'WORKS_AT',
        fact: 'Alice works at Acme',
        fact_embedding: null,
        episodes: ['ep1'],
        expired_at: null,
        valid_at: null,
        invalid_at: null
      }
    ];
    const driver = makeMockDriver(records);
    const result = await getRelevantEdges(driver, ['n1']);
    expect(result).toHaveLength(1);
    expect(result[0]!.fact).toBe('Alice works at Acme');
  });
});

// ---------------------------------------------------------------------------
// getRelevantNodes
// ---------------------------------------------------------------------------

describe('getRelevantNodes', () => {
  test('returns empty array for empty node UUIDs', async () => {
    const driver = makeMockDriver();
    const result = await getRelevantNodes(driver, []);
    expect(result).toEqual([]);
  });

  test('returns mapped nodes from query results', async () => {
    const records = [
      {
        uuid: 'n2',
        name: 'Acme',
        group_id: 'g1',
        labels: ['Entity', 'Organization'],
        created_at: '2024-01-15T00:00:00Z',
        name_embedding: null,
        summary: 'A company',
        attributes: null
      }
    ];
    const driver = makeMockDriver(records);
    const result = await getRelevantNodes(driver, ['n1']);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Acme');
  });
});

// ---------------------------------------------------------------------------
// getEdgeInvalidationCandidates
// ---------------------------------------------------------------------------

describe('getEdgeInvalidationCandidates', () => {
  test('returns edges from query results', async () => {
    const records = [
      {
        uuid: 'e-old',
        group_id: 'g1',
        source_node_uuid: 'n1',
        target_node_uuid: 'n2',
        created_at: '2024-01-15T00:00:00Z',
        name: 'WORKS_AT',
        fact: 'Old fact',
        fact_embedding: null,
        episodes: ['ep1'],
        expired_at: null,
        valid_at: null,
        invalid_at: null
      }
    ];
    const driver = makeMockDriver(records);
    const result = await getEdgeInvalidationCandidates(driver, 'n1', 'n2');
    expect(result).toHaveLength(1);
    expect(result[0]!.uuid).toBe('e-old');
  });

  test('passes exclude_uuids to query', async () => {
    // With empty records, just verify it doesn't throw
    const driver = makeMockDriver([]);
    const result = await getEdgeInvalidationCandidates(driver, 'n1', 'n2', ['e-skip']);
    expect(result).toEqual([]);
  });
});
