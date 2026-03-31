import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { CommunityNode, EntityNode } from '../domain/nodes';
import type { CommunityEdge } from '../domain/edges';
import type { LLMClient, GraphDriver } from '../contracts';

import {
  labelPropagation,
  buildCommunity,
  buildCommunities,
  buildCommunityEdges,
  removeCommunities,
  determineEntityCommunity,
  updateCommunity,
  summarizePair,
  generateSummaryDescription,
  MAX_COMMUNITY_BUILD_CONCURRENCY,
  type Neighbor,
  type EntityNodeNamespaceReader,
  type CommunityNamespaceWriter
} from './community-operations';

function rec(data: Record<string, unknown>) {
  return { get: (k: string) => data[k] };
}

function entity(uuid: string, name: string, summary: string): EntityNode {
  return { uuid, name, group_id: 'g1', labels: ['Entity'], created_at: utcNow(), summary };
}

function fakeLLM(responses: string[]): LLMClient {
  let i = 0;
  return {
    model: 'fake', small_model: null, setTracer() {},
    async generateText(): Promise<string> { return responses[i++] ?? '{}'; }
  };
}

describe('labelPropagation', () => {
  test('two cliques', () => {
    const p = new Map<string, Neighbor[]>([
      ['A', [{ node_uuid: 'B', edge_count: 2 }, { node_uuid: 'C', edge_count: 2 }]],
      ['B', [{ node_uuid: 'A', edge_count: 2 }, { node_uuid: 'C', edge_count: 2 }]],
      ['C', [{ node_uuid: 'A', edge_count: 2 }, { node_uuid: 'B', edge_count: 2 }]],
      ['D', [{ node_uuid: 'E', edge_count: 2 }]],
      ['E', [{ node_uuid: 'D', edge_count: 2 }]]
    ]);
    const c = labelPropagation(p);
    expect(c).toHaveLength(2);
    const sets = c.map((x) => new Set(x));
    expect(sets.some((s) => s.has('A') && s.has('B') && s.has('C'))).toBe(true);
    expect(sets.some((s) => s.has('D') && s.has('E'))).toBe(true);
  });

  test('isolated and empty and single', () => {
    expect(labelPropagation(new Map([['X', []], ['Y', []], ['Z', []]]))).toHaveLength(3);
    expect(labelPropagation(new Map())).toHaveLength(0);
    expect(labelPropagation(new Map([['A', []]]))).toHaveLength(1);
  });

  test('fully connected', () => {
    const p = new Map<string, Neighbor[]>([
      ['A', [{ node_uuid: 'B', edge_count: 2 }, { node_uuid: 'C', edge_count: 2 }]],
      ['B', [{ node_uuid: 'A', edge_count: 2 }, { node_uuid: 'C', edge_count: 2 }]],
      ['C', [{ node_uuid: 'A', edge_count: 2 }, { node_uuid: 'B', edge_count: 2 }]]
    ]);
    expect(labelPropagation(p)).toHaveLength(1);
  });
});

describe('summarizePair', () => {
  test('parses JSON', async () => {
    expect(await summarizePair(fakeLLM(['{"summary":"X"}']), ['A', 'B'])).toBe('X');
  });
});

describe('buildCommunity', () => {
  test('single', async () => {
    const [node, edges] = await buildCommunity(fakeLLM(['{"description":"Eng"}']), [entity('e1', 'A', 'eng')]);
    expect(node.summary).toBe('eng');
    expect(edges).toHaveLength(1);
  });
});

describe('buildCommunity two', () => {
  test('two entities', async () => {
    const [node, edges] = await buildCommunity(
      fakeLLM(['{"summary":"AB"}', '{"description":"Team"}']),
      [entity('e1', 'A', 'SA'), entity('e2', 'B', 'SB')]
    );
    expect(node.name).toBe('Team');
    expect(edges).toHaveLength(2);
  });
});

describe('three entities', () => {
  test('odd count', async () => {
    const [node, edges] = await buildCommunity(
      fakeLLM(['{"summary":"AB"}', '{"summary":"ABC"}', '{"description":"Three"}']),
      [entity('e1', 'A', 'SA'), entity('e2', 'B', 'SB'), entity('e3', 'C', 'SC')]
    );
    expect(node.name).toBe('Three');
    expect(edges).toHaveLength(3);
  });
});

describe('buildCommunityEdges', () => {
  test('creates edges', () => {
    const cn: CommunityNode = { uuid: 'c1', name: 'C', group_id: 'g1', labels: ['Community'], created_at: utcNow(), summary: 's' };
    const edges = buildCommunityEdges([entity('e1', 'A', 'sa'), entity('e2', 'B', 'sb')], cn, utcNow());
    expect(edges).toHaveLength(2);
    expect(edges[0].source_node_uuid).toBe('c1');
    expect(edges[0].uuid).not.toBe(edges[1].uuid);
  });
});

describe('generateSummaryDescription', () => {
  test('parses JSON', async () => {
    expect(await generateSummaryDescription(fakeLLM(['{"description":"D"}']), 'S')).toBe('D');
  });
});

// buildCommunities orchestration tested via integration tests

describe('removeCommunities', () => {
  test('DETACH DELETE', async () => {
    let q = '';
    const driver = { async executeQuery(query: string) { q = query; return { records: [], summary: {} }; } } as unknown as GraphDriver;
    await removeCommunities(driver);
    expect(q).toContain('DETACH DELETE');
  });
});

describe('determineEntityCommunity', () => {
  test('existing member', async () => {
    const driver = {
      async executeQuery() {
        return {
          records: [rec({ uuid: 'c1', name: 'T', group_id: 'g1', labels: ['Community'], created_at: utcNow().toISOString(), summary: 'S', name_embedding: null, rank: null })],
          summary: {}
        };
      }
    } as unknown as GraphDriver;
    const [c, isNew] = await determineEntityCommunity(driver, entity('e1', 'A', 'eng'));
    expect(c!.uuid).toBe('c1');
    expect(isNew).toBe(false);
  });

  test('mode of neighbors', async () => {
    let qc = 0;
    const driver = {
      async executeQuery() {
        qc++;
        if (qc === 1) return { records: [], summary: {} };
        return {
          records: [
            rec({ uuid: 'c2', name: 'C2', group_id: 'g1', labels: ['Community'], created_at: utcNow().toISOString(), summary: 'S', name_embedding: null, rank: null }),
            rec({ uuid: 'c2', name: 'C2', group_id: 'g1', labels: ['Community'], created_at: utcNow().toISOString(), summary: 'S', name_embedding: null, rank: null }),
            rec({ uuid: 'c3', name: 'C3', group_id: 'g1', labels: ['Community'], created_at: utcNow().toISOString(), summary: 'S', name_embedding: null, rank: null })
          ],
          summary: {}
        };
      }
    } as unknown as GraphDriver;
    const [c, isNew] = await determineEntityCommunity(driver, entity('e1', 'A', 'eng'));
    expect(c!.uuid).toBe('c2');
    expect(isNew).toBe(true);
  });

  test('no community', async () => {
    const driver = { async executeQuery() { return { records: [], summary: {} }; } } as unknown as GraphDriver;
    const [c, isNew] = await determineEntityCommunity(driver, entity('e1', 'A', 'eng'));
    expect(c).toBeNull();
    expect(isNew).toBe(false);
  });
});

describe('updateCommunity', () => {
  test('merges entity', async () => {
    let savedNode: CommunityNode | null = null;
    let savedEdge: CommunityEdge | null = null;
    let qc = 0;
    const driver = {
      async executeQuery() {
        qc++;
        if (qc === 1) return { records: [], summary: {} };
        return { records: [rec({ uuid: 'c1', name: 'Old', group_id: 'g1', labels: ['Community'], created_at: utcNow().toISOString(), summary: 'Old', name_embedding: null, rank: null })], summary: {} };
      }
    } as unknown as GraphDriver;
    const ns: CommunityNamespaceWriter = {
      node: { async save(n: CommunityNode) { savedNode = n; return n; } },
      edge: { async save(e: CommunityEdge) { savedEdge = e; return e; } }
    };
    const [nodes, edges] = await updateCommunity(driver, fakeLLM(['{"summary":"Up"}', '{"description":"New"}']), { async create() { return [0.1]; } }, ns, entity('e1', 'A', 'New'));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].summary).toBe('Up');
    expect(edges).toHaveLength(1);
    expect(savedNode).not.toBeNull();
    expect(savedEdge).not.toBeNull();
  });

  test('no community', async () => {
    const driver = { async executeQuery() { return { records: [], summary: {} }; } } as unknown as GraphDriver;
    const ns: CommunityNamespaceWriter = {
      node: { async save(n: CommunityNode) { return n; } },
      edge: { async save(e: CommunityEdge) { return e; } }
    };
    const [nodes, edges] = await updateCommunity(driver, fakeLLM([]), { async create() { return []; } }, ns, entity('e1', 'A', 'eng'));
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});

describe('constants', () => {
  test('concurrency', () => {
    expect(MAX_COMMUNITY_BUILD_CONCURRENCY).toBe(10);
  });
});
