import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { GraphDriver, GraphDriverSession, QueryOptions, QueryResult } from '../contracts';
import { Neo4jDriver } from '../driver/neo4j-driver';
import {
  createEdgeSearchConfig,
  createEpisodeSearchConfig,
  createNodeSearchConfig,
  createSearchConfig,
  EdgeRerankers,
  EdgeSearchMethods,
  EpisodeRerankers,
  NodeRerankers,
  EpisodeSearchMethods,
  NodeSearchMethods
} from './config';
import { createSearchFilters } from './filters';
import { search } from './search';

describe('search', () => {
  test('returns node and edge matches through Neo4j search ops', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25]
        }),
        episode_config: createEpisodeSearchConfig({
          search_methods: [EpisodeSearchMethods.bm25]
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25]
        })
      }),
      createSearchFilters({
        node_labels: ['Person']
      })
    );

    expect(results.nodes).toHaveLength(1);
    expect(results.nodes[0]?.name).toBe('Alice');
    expect(results.edges).toHaveLength(1);
    expect(results.edges[0]?.fact).toBe('Alice knows Bob');
    expect(results.episodes).toHaveLength(1);
    expect(results.episodes[0]?.content).toBe('Alice appeared');
  });

  test('fuses bm25 and bfs results through reciprocal rank fusion', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchFusionFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        limit: 2,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.bfs]
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.bfs]
        })
      }),
      createSearchFilters({
        node_labels: ['Person']
      })
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-1', 'entity-2']);
    expect(results.edges.map((edge) => edge.uuid)).toEqual(['edge-1', 'edge-2']);
    expect(results.node_reranker_scores).toEqual([2, 0.5]);
    expect(results.edge_reranker_scores).toEqual([1.5, 1]);
  });

  test('supports node-distance reranking for node and edge results', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchFusionFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        limit: 2,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.bfs],
          reranker: NodeRerankers.node_distance
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.bfs],
          reranker: EdgeRerankers.node_distance
        })
      }),
      createSearchFilters({
        node_labels: ['Person']
      }),
      {
        center_node_uuid: 'entity-2'
      }
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-2', 'entity-1']);
    expect(results.edges.map((edge) => edge.uuid)).toEqual(['edge-2', 'edge-1']);
    expect(results.node_reranker_scores).toEqual([10, 1]);
    expect(results.edge_reranker_scores).toEqual([10, 1]);
  });

  test('supports episode-mentions reranking for node and edge results', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchFusionFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        limit: 2,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.bfs],
          reranker: NodeRerankers.episode_mentions
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.bfs],
          reranker: EdgeRerankers.episode_mentions
        })
      }),
      createSearchFilters({
        node_labels: ['Person']
      })
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-1', 'entity-2']);
    expect(results.edges.map((edge) => edge.uuid)).toEqual(['edge-2', 'edge-1']);
    expect(results.node_reranker_scores).toEqual([3, 1]);
    expect(results.edge_reranker_scores).toEqual([2, 1]);
  });

  test('supports cosine similarity search for nodes and edges', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchVectorFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        limit: 2,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.cosine_similarity]
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.cosine_similarity]
        })
      }),
      createSearchFilters({
        node_labels: ['Person']
      }),
      {
        query_embedding: [1, 0]
      }
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-1', 'entity-2']);
    expect(results.edges.map((edge) => edge.uuid)).toEqual(['edge-1', 'edge-2']);
  });

  test('supports mmr reranking for nodes and edges', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchVectorFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        limit: 2,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25],
          reranker: NodeRerankers.mmr,
          mmr_lambda: 0.3
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25],
          reranker: EdgeRerankers.mmr,
          mmr_lambda: 0.3
        })
      }),
      createSearchFilters({
        node_labels: ['Person']
      }),
      {
        query_embedding: [1, 0]
      }
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-1', 'entity-3']);
    expect(results.edges.map((edge) => edge.uuid)).toEqual(['edge-1', 'edge-3']);
  });

  test('supports cross encoder reranking for nodes and edges', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchVectorFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        limit: 2,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25],
          reranker: NodeRerankers.cross_encoder
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25],
          reranker: EdgeRerankers.cross_encoder
        })
      }),
      createSearchFilters({
        node_labels: ['Person']
      }),
      {},
      new FakeCrossEncoder()
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-3', 'entity-1']);
    expect(results.edges.map((edge) => edge.uuid)).toEqual(['edge-2', 'edge-3']);
  });

  test('supports cross encoder reranking for episodes', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchEpisodeVectorFakeNeo4jClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        limit: 2,
        episode_config: createEpisodeSearchConfig({
          search_methods: [EpisodeSearchMethods.bm25],
          reranker: EpisodeRerankers.cross_encoder
        })
      }),
      createSearchFilters(),
      {},
      new FakeCrossEncoder()
    );

    expect(results.episodes.map((episode) => episode.uuid)).toEqual(['episode-2', 'episode-1']);
  });
});

class SearchFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)')) {
      return {
        records: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: null,
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ]
      };
    }

    if (query.includes('MATCH (n:Entity)')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    if (query.includes('MATCH (n:Episodic)')) {
      return {
        records: [
          {
            uuid: 'episode-1',
            name: 'episode',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: utcNow().toISOString(),
            source: 'text',
            source_description: 'chat',
            content: 'Alice appeared',
            valid_at: utcNow().toISOString(),
            entity_edges: ['edge-1']
          } as RecordShape
        ]
      };
    }

    return { records: [] };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

class SearchFusionFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (query.includes('OPTIONAL MATCH (:Episodic)-[:MENTIONS]->(n)')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            mentions: 3
          } as RecordShape,
          {
            uuid: 'entity-2',
            mentions: 1
          } as RecordShape
        ]
      };
    }

    if (query.includes('OPTIONAL MATCH path = shortestPath')) {
      return {
        records: [
          {
            uuid: 'entity-2',
            distance: 0.1
          } as RecordShape,
          {
            uuid: 'entity-1',
            distance: 1
          } as RecordShape
        ]
      };
    }

    if (query.includes('MATCH path = (origin)-[:RELATES_TO*1..')) {
      if (query.includes('UNWIND relationships(path) AS e')) {
        return {
          records: [
            {
              uuid: 'edge-2',
              group_id: 'group',
              source_node_uuid: 'entity-2',
              target_node_uuid: 'entity-3',
              created_at: utcNow().toISOString(),
              name: 'works_with',
              fact: 'Bob works with Carol',
              fact_embedding: null,
              episodes: ['episode-1', 'episode-2'],
              expired_at: null,
              valid_at: null,
              invalid_at: null
            } as RecordShape,
            {
              uuid: 'edge-1',
              group_id: 'group',
              source_node_uuid: 'entity-1',
              target_node_uuid: 'entity-2',
              created_at: utcNow().toISOString(),
              name: 'knows',
              fact: 'Alice knows Bob',
              fact_embedding: null,
              episodes: [],
              expired_at: null,
              valid_at: null,
              invalid_at: null
            } as RecordShape,
          ]
        };
      }

      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    if (query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)')) {
      return {
        records: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: null,
            episodes: ['episode-1'],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ]
      };
    }

    return {
      records: [
        {
          uuid: 'entity-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'summary',
          attributes: {}
        } as RecordShape
      ]
    };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

class SearchVectorFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (
      query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)') &&
      !query.includes('e.fact_embedding IS NOT NULL')
    ) {
      return {
        records: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: [1, 0],
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape,
          {
            uuid: 'edge-2',
            group_id: 'group',
            source_node_uuid: 'entity-2',
            target_node_uuid: 'entity-3',
            created_at: utcNow().toISOString(),
            name: 'works_with',
            fact: 'Bob works with Carol',
            fact_embedding: [0.95, 0.05],
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape,
          {
            uuid: 'edge-3',
            group_id: 'group',
            source_node_uuid: 'entity-3',
            target_node_uuid: 'entity-4',
            created_at: utcNow().toISOString(),
            name: 'met',
            fact: 'Carol met Dave',
            fact_embedding: [0, 1],
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ]
      };
    }

    if (
      query.includes('MATCH (n:Entity)') &&
      !query.includes('n.name_embedding IS NOT NULL') &&
      !query.includes('-[e:RELATES_TO]->')
    ) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [1, 0],
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [0.95, 0.05],
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-3',
            name: 'Carol',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [0, 1],
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    if (query.includes('e.fact_embedding IS NOT NULL')) {
      return {
        records: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: [1, 0],
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape,
          {
            uuid: 'edge-2',
            group_id: 'group',
            source_node_uuid: 'entity-2',
            target_node_uuid: 'entity-3',
            created_at: utcNow().toISOString(),
            name: 'works_with',
            fact: 'Bob works with Carol',
            fact_embedding: [0.95, 0.05],
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape,
          {
            uuid: 'edge-3',
            group_id: 'group',
            source_node_uuid: 'entity-3',
            target_node_uuid: 'entity-4',
            created_at: utcNow().toISOString(),
            name: 'met',
            fact: 'Carol met Dave',
            fact_embedding: [0, 1],
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ]
      };
    }

    if (query.includes('n.name_embedding IS NOT NULL')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [1, 0],
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [0.95, 0.05],
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-3',
            name: 'Carol',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [0, 1],
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    return { records: [] };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

class FakeCrossEncoder {
  async rank(query: string, passages: string[]): Promise<Array<[string, number]>> {
    return passages
      .map((passage) => [passage, computeCrossEncoderScore(query, passage)] as [string, number])
      .sort((left, right) => right[1] - left[1]);
  }
}

class SearchEpisodeVectorFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (query.includes('MATCH (n:Episodic)')) {
      return {
        records: [
          {
            uuid: 'episode-1',
            name: 'episode one',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: utcNow().toISOString(),
            source: 'text',
            source_description: 'chat',
            content: 'Alice greeted Bob',
            valid_at: utcNow().toISOString(),
            entity_edges: []
          } as RecordShape,
          {
            uuid: 'episode-2',
            name: 'episode two',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: utcNow().toISOString(),
            source: 'text',
            source_description: 'chat',
            content: 'Carol mentioned Alice directly',
            valid_at: utcNow().toISOString(),
            entity_edges: []
          } as RecordShape
        ]
      };
    }

    return { records: [] };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

function computeCrossEncoderScore(query: string, passage: string): number {
  if (query === 'alice' && passage.includes('Carol')) {
    return 0.95;
  }

  if (query === 'alice' && passage.includes('Alice')) {
    return 0.75;
  }

  return 0.25;
}
