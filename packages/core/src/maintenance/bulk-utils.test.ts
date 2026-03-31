import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import type { Message } from '../prompts/types';

import { addNodesAndEdgesBulk } from './bulk-utils';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEpisode(uuid: string, content: string): EpisodicNode {
  return {
    uuid,
    name: `episode-${uuid}`,
    group_id: 'g1',
    labels: ['Episodic'],
    created_at: utcNow(),
    source: 'message',
    source_description: 'test',
    content,
    valid_at: utcNow()
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

function makeEntityEdge(
  uuid: string,
  sourceUuid: string,
  targetUuid: string,
  fact: string
): EntityEdge {
  return {
    uuid,
    group_id: 'g1',
    source_node_uuid: sourceUuid,
    target_node_uuid: targetUuid,
    created_at: utcNow(),
    name: 'RELATES_TO',
    fact
  };
}

function makeEpisodicEdge(
  episodeUuid: string,
  nodeUuid: string
): EpisodicEdge {
  return {
    uuid: `${episodeUuid}:${nodeUuid}`,
    group_id: 'g1',
    source_node_uuid: episodeUuid,
    target_node_uuid: nodeUuid,
    created_at: utcNow()
  };
}

function makeMockEmbedder() {
  const createCalls: string[][] = [];
  return {
    embedder: {
      create: async (texts: string[]) => {
        createCalls.push(texts);
        return [0.1, 0.2, 0.3, 0.4, 0.5];
      }
    },
    createCalls
  };
}

function makeMockDriver() {
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  return {
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
      executeQuery: async (query: string, options?: Record<string, unknown>) => {
        queries.push({ query, params: (options as any)?.params ?? {} });
        return { records: [] };
      }
    } as any,
    queries
  };
}

// ---------------------------------------------------------------------------
// addNodesAndEdgesBulk
// ---------------------------------------------------------------------------

describe('addNodesAndEdgesBulk', () => {
  test('generates embeddings for nodes without embeddings', async () => {
    const { embedder, createCalls } = makeMockEmbedder();
    const { driver } = makeMockDriver();

    const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Bob')];
    await addNodesAndEdgesBulk(driver, [], [], nodes, [], embedder);

    // Should have created embeddings for both nodes
    expect(createCalls.length).toBe(2);
  });

  test('skips embedding for nodes that already have embeddings', async () => {
    const { embedder, createCalls } = makeMockEmbedder();
    const { driver } = makeMockDriver();

    const node = makeNode('n1', 'Alice');
    node.name_embedding = [0.1, 0.2];

    await addNodesAndEdgesBulk(driver, [], [], [node], [], embedder);
    expect(createCalls.length).toBe(0);
  });

  test('generates embeddings for edges without embeddings', async () => {
    const { embedder, createCalls } = makeMockEmbedder();
    const { driver } = makeMockDriver();

    const edges = [makeEntityEdge('e1', 'n1', 'n2', 'Alice works at Acme')];
    await addNodesAndEdgesBulk(driver, [], [], [], edges, embedder);

    expect(createCalls.length).toBe(1);
    expect(createCalls[0]![0]).toContain('Alice works at Acme');
  });

  test('saves episodes to database', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    const episodes = [makeEpisode('ep1', 'Hello world')];
    await addNodesAndEdgesBulk(driver, episodes, [], [], [], embedder);

    const episodeQueries = queries.filter((q) => q.query.includes('Episodic'));
    expect(episodeQueries.length).toBe(1);
    expect(episodeQueries[0]!.params.uuid).toBe('ep1');
  });

  test('saves entity nodes to database', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    const nodes = [makeNode('n1', 'Alice')];
    await addNodesAndEdgesBulk(driver, [], [], nodes, [], embedder);

    const nodeQueries = queries.filter(
      (q) => q.query.includes('Entity') && q.query.includes('MERGE')
    );
    expect(nodeQueries.length).toBeGreaterThanOrEqual(1);
  });

  test('saves episodic edges to database', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    const episodicEdges = [makeEpisodicEdge('ep1', 'n1')];
    await addNodesAndEdgesBulk(driver, [], episodicEdges, [], [], embedder);

    const edgeQueries = queries.filter((q) => q.query.includes('MENTIONS'));
    expect(edgeQueries.length).toBe(1);
  });

  test('saves entity edges to database', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    const entityEdges = [makeEntityEdge('e1', 'n1', 'n2', 'Alice knows Bob')];
    await addNodesAndEdgesBulk(driver, [], [], [], entityEdges, embedder);

    const edgeQueries = queries.filter((q) => q.query.includes('RELATES_TO'));
    expect(edgeQueries.length).toBe(1);
  });

  test('handles all empty inputs', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    await addNodesAndEdgesBulk(driver, [], [], [], [], embedder);
    expect(queries.length).toBe(0);
  });
});
