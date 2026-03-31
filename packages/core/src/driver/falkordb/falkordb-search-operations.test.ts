import { describe, expect, test } from 'bun:test';

import { FalkorDriver } from '../falkordb-driver';
import {
  createEdgeSearchConfig,
  createNodeSearchConfig,
  createSearchConfig,
  EdgeRerankers,
  EdgeSearchMethods,
  NodeRerankers,
  NodeSearchMethods
} from '../../search/config';
import { createSearchFilters } from '../../search/filters';
import { search } from '../../search/search';

describe('Falkor search operations', () => {
  test('returns node and edge matches through Falkor search ops', async () => {
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new FalkorSearchClient()
    );

    const results = await search(
      driver,
      'alice',
      ['group'],
      createSearchConfig({
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25]
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
  });

  test('supports bfs fusion through Falkor search ops', async () => {
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new FalkorSearchClient()
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
    expect(results.edge_reranker_scores).toEqual([2, 0.5]);
  });

  test('supports episode-mentions reranking through Falkor search ops', async () => {
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new FalkorSearchClient()
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
});

class FalkorSearchClient {
  selectGraph(_graphId: string): FalkorSearchGraph {
    return new FalkorSearchGraph();
  }

  async close(): Promise<void> {}
}

class FalkorSearchGraph {
  async query<RecordShape = unknown>(
    query: string
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (query.includes('OPTIONAL MATCH (:Episodic)-[:MENTIONS]->(n)')) {
      return {
        data: [
          {
            uuid: 'entity-1',
            mentions: 3
          } as RecordShape,
          {
            uuid: 'entity-2',
            mentions: 1
          } as RecordShape
        ],
        headers: []
      };
    }

    if (query.includes('MATCH path = (origin)-[:RELATES_TO*1..')) {
      if (query.includes('UNWIND relationships(path) AS e')) {
        return {
          data: [
            {
              uuid: 'edge-1',
              group_id: 'group',
              source_node_uuid: 'entity-1',
              target_node_uuid: 'entity-2',
              created_at: new Date().toISOString(),
              name: 'knows',
              fact: 'Alice knows Bob',
              fact_embedding: null,
              episodes: ['episode-1'],
              expired_at: null,
              valid_at: null,
              invalid_at: null
            } as RecordShape,
            {
              uuid: 'edge-2',
              group_id: 'group',
              source_node_uuid: 'entity-2',
              target_node_uuid: 'entity-3',
              created_at: new Date().toISOString(),
              name: 'works_with',
              fact: 'Bob works with Carol',
              fact_embedding: null,
              episodes: ['episode-1', 'episode-2'],
              expired_at: null,
              valid_at: null,
              invalid_at: null
            } as RecordShape
          ],
          headers: []
        };
      }

      return {
        data: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: new Date().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: new Date().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ],
        headers: []
      };
    }

    if (query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)')) {
      return {
        data: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: new Date().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: null,
            episodes: ['episode-1'],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ],
        headers: []
      };
    }

    if (query.includes('MATCH (n:Entity)')) {
      return {
        data: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: new Date().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ],
        headers: []
      };
    }

    return { data: [], headers: [] };
  }

  async roQuery<RecordShape = unknown>(
    query: string
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.query<RecordShape>(query);
  }

  async createNodeRangeIndex(): Promise<void> {}
  async createNodeFulltextIndex(): Promise<void> {}
  async createEdgeRangeIndex(): Promise<void> {}
  async createEdgeFulltextIndex(): Promise<void> {}
  async delete(): Promise<void> {}
}
