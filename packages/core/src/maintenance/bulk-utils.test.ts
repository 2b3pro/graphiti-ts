import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { addNodesAndEdgesBulk, dedupeEdgesBulk } from './bulk-utils';

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

function makeBatchEmbedder() {
  const createCalls: string[][] = [];
  const createBatchCalls: string[][] = [];
  return {
    embedder: {
      create: async (texts: string[]) => {
        createCalls.push(texts);
        return [0.1, 0.2, 0.3];
      },
      createBatch: async (texts: string[]) => {
        createBatchCalls.push(texts);
        return texts.map(() => [0.1, 0.2, 0.3]);
      }
    },
    createCalls,
    createBatchCalls
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

  test('prefers batch embedding generation when configured and supported', async () => {
    const { embedder, createCalls, createBatchCalls } = makeBatchEmbedder();
    const { driver } = makeMockDriver();

    const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Bob')];
    const edges = [makeEntityEdge('e1', 'n1', 'n2', 'Alice knows Bob')];

    await addNodesAndEdgesBulk(driver, [], [], nodes, edges, embedder, {
      prefer_batch_embeddings: true
    });

    expect(createCalls.length).toBe(0);
    expect(createBatchCalls).toHaveLength(2);
    expect(createBatchCalls[0]).toEqual(['Alice', 'Bob']);
    expect(createBatchCalls[1]).toEqual(['Alice knows Bob']);
  });

  test('saves episodes to database', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    const episodes = [makeEpisode('ep1', 'Hello world')];
    await addNodesAndEdgesBulk(driver, episodes, [], [], [], embedder);

    const episodeQueries = queries.filter((q) => q.query.includes('Episodic'));
    expect(episodeQueries.length).toBe(1);
    expect(episodeQueries[0]!.params.episode).toMatchObject({
      uuid: 'ep1',
      content: 'Hello world'
    });
    expect(episodeQueries[0]!.params.labels).toEqual(['Episodic']);
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

  test('persists full serialized entity and edge fields in bulk mode', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    const node = makeNode('n1', 'Alice');
    node.attributes = { role: 'engineer', sources: ['chat'] };

    const edge = makeEntityEdge('e1', 'n1', 'n2', 'Alice knows Bob');
    edge.confidence = [0.91, 0.91, 0.91];
    edge.epistemic_status = 'claim';
    edge.conditions = [{ type: 'temporal', value: 'current' }] as any;
    edge.interpretations = [{ interpretation: 'colleagues', confidence: 0.8 }] as any;
    edge.attributes = { deprecation_reason: null };

    await addNodesAndEdgesBulk(driver, [], [], [node], [edge], embedder);

    const nodeQuery = queries.find((q) => q.query.includes('MERGE (n:Entity'))!;
    const edgeQuery = queries.find((q) => q.query.includes('MERGE (source)-[e:RELATES_TO'))!;

    expect(nodeQuery.params.entity).toMatchObject({
      uuid: 'n1'
    });
    expect(JSON.parse((nodeQuery.params.entity as any).attributes)).toEqual({
      role: 'engineer',
      sources: ['chat']
    });
    expect(edgeQuery.params.edge).toMatchObject({
      uuid: 'e1',
      confidence: [0.91, 0.91, 0.91],
      epistemic_status: 'claim'
    });
    expect(JSON.parse((edgeQuery.params.edge as any).attributes)).toEqual({
      deprecation_reason: null
    });
    expect(JSON.parse((edgeQuery.params.edge as any).conditions)).toBeArray();
    expect(JSON.parse((edgeQuery.params.edge as any).interpretations)).toBeArray();
  });

  test('handles all empty inputs', async () => {
    const { embedder } = makeMockEmbedder();
    const { driver, queries } = makeMockDriver();

    await addNodesAndEdgesBulk(driver, [], [], [], [], embedder);
    expect(queries.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dedupeEdgesBulk
// ---------------------------------------------------------------------------

describe('dedupeEdgesBulk', () => {
  test('preserves source-target candidate behavior across relation names', async () => {
    const firstEpisode = makeEpisode('ep1', 'Alice uses Acme');
    const secondEpisode = makeEpisode('ep2', 'Alice prefers Acme');
    const firstEdge = makeEntityEdge('e1', 'alice', 'acme', 'Alice uses Acme');
    const secondEdge = makeEntityEdge('e2', 'alice', 'acme', 'Alice uses Acme');
    firstEdge.name = 'USES';
    secondEdge.name = 'PREFERS';
    firstEdge.fact_embedding = [1, 0];
    secondEdge.fact_embedding = [1, 0];

    const result = await dedupeEdgesBulk(
      {
        llm_client: {
          model: 'test',
          small_model: 'test-small',
          setTracer: () => {},
          generateText: async () => JSON.stringify({ duplicate_facts: [], contradicted_facts: [] })
        },
        embedder: {
          create: async () => [1, 0]
        },
        driver: makeMockDriver().driver,
        cross_encoder: {
          rank: async () => []
        },
        tracer: {
          startSpan: () => ({
            span: {
              addAttributes: () => {},
              setStatus: () => {},
              recordException: () => {}
            },
            close: () => {}
          })
        }
      } as any,
      [[firstEdge], [secondEdge]],
      [
        [firstEpisode, []],
        [secondEpisode, []]
      ],
      {}
    );

    expect(result.ep1?.[0]?.uuid).toBe('e1');
    expect(result.ep2?.[0]?.uuid).toBe('e1');
  });
});
