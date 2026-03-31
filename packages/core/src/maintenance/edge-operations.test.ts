import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { LLMClient } from '../contracts';
import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import type { Message } from '../prompts/types';

import {
  buildEpisodicEdges,
  resolveEdgePointers,
  extractEdges,
  resolveExtractedEdge
} from './edge-operations';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEpisode(overrides: Partial<EpisodicNode> = {}): EpisodicNode {
  return {
    uuid: 'ep-1',
    name: 'episode-1',
    group_id: 'g1',
    labels: ['Episodic'],
    created_at: utcNow(),
    source: 'message',
    source_description: 'test',
    content: 'Alice works at Acme Corp.',
    valid_at: utcNow(),
    ...overrides
  };
}

function makeNode(uuid: string, name: string): EntityNode {
  return {
    uuid,
    name,
    group_id: 'g1',
    labels: ['Entity'],
    created_at: utcNow(),
    summary: ''
  };
}

function makeEdge(
  uuid: string,
  sourceUuid: string,
  targetUuid: string,
  fact: string,
  overrides: Partial<EntityEdge> = {}
): EntityEdge {
  return {
    uuid,
    group_id: 'g1',
    source_node_uuid: sourceUuid,
    target_node_uuid: targetUuid,
    created_at: utcNow(),
    name: 'RELATES_TO',
    fact,
    ...overrides
  };
}

function makeMockLLMClient(responses: Record<string, unknown>[]): LLMClient {
  let callIndex = 0;
  return {
    model: 'test-model',
    small_model: 'test-small',
    setTracer: () => {},
    generateText: async (_messages: Message[]) => {
      const resp = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return JSON.stringify(resp);
    }
  };
}

function makeMockClients(llmResponses: Record<string, unknown>[]) {
  return {
    llm_client: makeMockLLMClient(llmResponses),
    embedder: {
      create: async (texts: string[]) =>
        texts[0]!.split('').map((_, i) => (i % 10) / 10)
    },
    driver: {
      provider: 'mock',
      default_group_id: 'g1',
      database: 'test',
      session: () => ({ close: async () => {}, executeQuery: async () => ({ records: [] }) }),
      transaction: () => ({
        run: async () => ({ records: [] }),
        commit: async () => {},
        rollback: async () => {}
      }),
      close: async () => {},
      deleteAllIndexes: async () => {},
      buildIndicesAndConstraints: async () => {},
      executeQuery: async () => ({ records: [] })
    }
  } as any;
}

// ---------------------------------------------------------------------------
// buildEpisodicEdges
// ---------------------------------------------------------------------------

describe('buildEpisodicEdges', () => {
  test('creates one edge per entity node', () => {
    const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Bob')];
    const now = utcNow();
    const edges = buildEpisodicEdges(nodes, 'ep-1', now);

    expect(edges).toHaveLength(2);
  });

  test('sets source as episode UUID and target as node UUID', () => {
    const nodes = [makeNode('n1', 'Alice')];
    const edges = buildEpisodicEdges(nodes, 'ep-1', utcNow());

    expect(edges[0]!.source_node_uuid).toBe('ep-1');
    expect(edges[0]!.target_node_uuid).toBe('n1');
  });

  test('creates deterministic UUID from episode:node', () => {
    const nodes = [makeNode('n1', 'Alice')];
    const edges = buildEpisodicEdges(nodes, 'ep-1', utcNow());

    expect(edges[0]!.uuid).toBe('ep-1:n1');
  });

  test('uses node group_id for edge group_id', () => {
    const node = makeNode('n1', 'Alice');
    node.group_id = 'custom-group';
    const edges = buildEpisodicEdges([node], 'ep-1', utcNow());

    expect(edges[0]!.group_id).toBe('custom-group');
  });

  test('handles empty node array', () => {
    const edges = buildEpisodicEdges([], 'ep-1', utcNow());
    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveEdgePointers
// ---------------------------------------------------------------------------

describe('resolveEdgePointers', () => {
  test('remaps source and target UUIDs using uuidMap', () => {
    const edges: EntityEdge[] = [
      makeEdge('e1', 'old-source', 'old-target', 'fact1')
    ];
    const uuidMap = { 'old-source': 'new-source', 'old-target': 'new-target' };

    const resolved = resolveEdgePointers(edges, uuidMap);
    expect(resolved[0]!.source_node_uuid).toBe('new-source');
    expect(resolved[0]!.target_node_uuid).toBe('new-target');
  });

  test('keeps original UUID when not in map', () => {
    const edges: EntityEdge[] = [
      makeEdge('e1', 'source-1', 'target-1', 'fact1')
    ];
    const uuidMap = { 'source-1': 'mapped-source' };

    const resolved = resolveEdgePointers(edges, uuidMap);
    expect(resolved[0]!.source_node_uuid).toBe('mapped-source');
    expect(resolved[0]!.target_node_uuid).toBe('target-1'); // unchanged
  });

  test('handles empty edges array', () => {
    expect(resolveEdgePointers([], {})).toHaveLength(0);
  });

  test('handles empty uuid map', () => {
    const edges = [makeEdge('e1', 's1', 't1', 'fact')];
    const resolved = resolveEdgePointers(edges, {});
    expect(resolved[0]!.source_node_uuid).toBe('s1');
    expect(resolved[0]!.target_node_uuid).toBe('t1');
  });

  test('preserves other edge properties', () => {
    const edge = makeEdge('e1', 's1', 't1', 'original fact', {
      name: 'WORKS_AT',
      episodes: ['ep-1']
    });
    const resolved = resolveEdgePointers([edge], { s1: 'new-s1' });
    expect(resolved[0]!.uuid).toBe('e1');
    expect(resolved[0]!.fact).toBe('original fact');
    expect(resolved[0]!.name).toBe('WORKS_AT');
    expect(resolved[0]!.episodes).toEqual(['ep-1']);
  });
});

// ---------------------------------------------------------------------------
// extractEdges
// ---------------------------------------------------------------------------

describe('extractEdges', () => {
  test('extracts edges from LLM response', async () => {
    const clients = makeMockClients([
      {
        edges: [
          {
            source_entity_name: 'Alice',
            target_entity_name: 'Acme',
            relation_type: 'WORKS_AT',
            fact: 'Alice works at Acme',
            valid_at: null,
            invalid_at: null
          }
        ]
      }
    ]);

    const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Acme')];
    const episode = makeEpisode();

    const edges = await extractEdges(
      clients,
      episode,
      nodes,
      [],
      {},
      'g1'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0]!.fact).toBe('Alice works at Acme');
    expect(edges[0]!.source_node_uuid).toBe('n1');
    expect(edges[0]!.target_node_uuid).toBe('n2');
    expect(edges[0]!.name).toBe('WORKS_AT');
  });

  test('filters out edges with unknown entity names', async () => {
    const clients = makeMockClients([
      {
        edges: [
          {
            source_entity_name: 'Alice',
            target_entity_name: 'Unknown',
            relation_type: 'KNOWS',
            fact: 'Alice knows Unknown',
            valid_at: null,
            invalid_at: null
          }
        ]
      }
    ]);

    const nodes = [makeNode('n1', 'Alice')]; // No 'Unknown' node
    const edges = await extractEdges(clients, makeEpisode(), nodes, [], {}, 'g1');
    expect(edges).toHaveLength(0);
  });

  test('filters out edges with empty facts', async () => {
    const clients = makeMockClients([
      {
        edges: [
          {
            source_entity_name: 'Alice',
            target_entity_name: 'Bob',
            relation_type: 'KNOWS',
            fact: '',
            valid_at: null,
            invalid_at: null
          }
        ]
      }
    ]);

    const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Bob')];
    const edges = await extractEdges(clients, makeEpisode(), nodes, [], {}, 'g1');
    expect(edges).toHaveLength(0);
  });

  test('parses valid_at and invalid_at dates', async () => {
    const clients = makeMockClients([
      {
        edges: [
          {
            source_entity_name: 'Alice',
            target_entity_name: 'Acme',
            relation_type: 'WORKS_AT',
            fact: 'Alice works at Acme',
            valid_at: '2024-01-15T00:00:00Z',
            invalid_at: '2024-06-30T00:00:00Z'
          }
        ]
      }
    ]);

    const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Acme')];
    const edges = await extractEdges(clients, makeEpisode(), nodes, [], {}, 'g1');

    expect(edges[0]!.valid_at).toBeInstanceOf(Date);
    expect(edges[0]!.invalid_at).toBeInstanceOf(Date);
  });

  test('handles empty LLM response', async () => {
    const clients = makeMockClients([{ edges: [] }]);
    const edges = await extractEdges(clients, makeEpisode(), [], [], {}, 'g1');
    expect(edges).toHaveLength(0);
  });

  test('handles missing edges key in response', async () => {
    const clients = makeMockClients([{}]);
    const edges = await extractEdges(clients, makeEpisode(), [], [], {}, 'g1');
    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveExtractedEdge
// ---------------------------------------------------------------------------

describe('resolveExtractedEdge', () => {
  test('returns edge as-is when no related or existing edges', async () => {
    const llmClient = makeMockLLMClient([]);
    const edge = makeEdge('e1', 's1', 't1', 'Alice works at Acme');
    const episode = makeEpisode();

    const [resolved, invalidated] = await resolveExtractedEdge(
      llmClient,
      edge,
      [],
      [],
      episode
    );

    expect(resolved.uuid).toBe('e1');
    expect(resolved.fact).toBe('Alice works at Acme');
    expect(invalidated).toHaveLength(0);
  });

  test('resolves exact match by fact text and endpoints', async () => {
    const llmClient = makeMockLLMClient([]);
    const extracted = makeEdge('new-1', 's1', 't1', 'Alice works at Acme');
    const existing = makeEdge('old-1', 's1', 't1', 'Alice works at Acme', {
      episodes: ['ep-0']
    });
    const episode = makeEpisode();

    const [resolved, invalidated] = await resolveExtractedEdge(
      llmClient,
      extracted,
      [existing],
      [],
      episode
    );

    // Should resolve to the existing edge
    expect(resolved.uuid).toBe('old-1');
    expect(resolved.episodes).toContain('ep-1');
    expect(invalidated).toHaveLength(0);
  });

  test('uses LLM for non-exact duplicates', async () => {
    const llmClient = makeMockLLMClient([
      { duplicate_facts: [0], contradicted_facts: [] }
    ]);

    const extracted = makeEdge('new-1', 's1', 't1', 'Alice is employed at Acme');
    const existing = makeEdge('old-1', 's1', 't1', 'Alice works at Acme');
    const episode = makeEpisode();

    const [resolved, invalidated] = await resolveExtractedEdge(
      llmClient,
      extracted,
      [existing],
      [],
      episode
    );

    // Should resolve to existing edge via LLM
    expect(resolved.uuid).toBe('old-1');
    expect(invalidated).toHaveLength(0);
  });

  test('identifies contradicted edges', async () => {
    const now = utcNow();
    const llmClient = makeMockLLMClient([
      { duplicate_facts: [], contradicted_facts: [1] }
    ]);

    const extracted = makeEdge('new-1', 's1', 't1', 'Alice works at NewCo', {
      valid_at: new Date('2024-06-01')
    });
    const related = makeEdge('old-related', 's1', 't1', 'Alice works at Acme');
    const existing = makeEdge('old-existing', 's1', 't1', 'Alice works at OldCo', {
      valid_at: new Date('2024-01-01')
    });
    const episode = makeEpisode();

    const [resolved, invalidated] = await resolveExtractedEdge(
      llmClient,
      extracted,
      [related],
      [existing],
      episode
    );

    expect(resolved.uuid).toBe('new-1');
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]!.uuid).toBe('old-existing');
  });

  test('extracts edge attributes when edge type has fields', async () => {
    const llmClient = makeMockLLMClient([
      { salary: 100000, department: 'Engineering' }
    ]);

    const edge = makeEdge('e1', 's1', 't1', 'Alice works at Acme', {
      name: 'WORKS_AT'
    });
    const episode = makeEpisode();

    const edgeTypes = {
      WORKS_AT: {
        description: 'Employment relationship',
        fields: { salary: { type: 'number' }, department: { type: 'string' } }
      }
    };

    const [resolved] = await resolveExtractedEdge(
      llmClient,
      edge,
      [],
      [],
      episode,
      edgeTypes
    );

    expect(resolved.attributes).toBeDefined();
  });
});
