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
import type { SearchFilters } from '../../search/filters';
import { createSearchFilters } from '../../search/filters';
import { search } from '../../search/search';
import type { GraphDriver, QueryOptions, QueryResult } from '../../contracts';
import type { RecordLike } from '../../utils/records';
import { buildFulltextQuery } from '../../utils/text';
import { FalkorSearchOperations } from './falkordb-search-operations';

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

  test('node fulltext search uses the FalkorDB fulltext procedure, ordered by score', async () => {
    const calls: CapturedCall[] = [];
    const ops = new FalkorSearchOperations();
    const driver = capturingDriver(
      async () => ({
        records: [{ uuid: 'n1', name: 'Alice' }] as RecordLike[],
        keys: [],
        summary: null
      }),
      calls
    );

    const nodes = await ops.nodeFulltextSearch(driver, 'alice (smith)', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("db.idx.fulltext.queryNodes('Entity'");
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    expect(calls[0]?.params.query).toBe(buildFulltextQuery('alice (smith)', ['g1']));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.uuid).toBe('n1');
  });

  test('node fulltext search returns empty for a blank query without a DB call', async () => {
    const calls: CapturedCall[] = [];
    const ops = new FalkorSearchOperations();
    const driver = capturingDriver(async () => ({ records: [], keys: [], summary: null }), calls);

    const nodes = await ops.nodeFulltextSearch(driver, '   ', emptyFilter, ['g1'], 5);

    expect(nodes).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('node fulltext search falls back to CONTAINS when the procedure errors', async () => {
    const calls: CapturedCall[] = [];
    const ops = new FalkorSearchOperations();
    const driver = capturingDriver(async (query) => {
      if (query.includes('db.idx.fulltext.queryNodes')) {
        throw new Error('Unknown procedure');
      }
      return { records: [{ uuid: 'n1', name: 'Alice' }] as RecordLike[], keys: [], summary: null };
    }, calls);

    const nodes = await ops.nodeFulltextSearch(driver, 'alice', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.query).toContain('CONTAINS');
    expect(nodes).toHaveLength(1);
  });

  test('edge fulltext search uses the FalkorDB relationship fulltext procedure', async () => {
    const calls: CapturedCall[] = [];
    const ops = new FalkorSearchOperations();
    const driver = capturingDriver(
      async () => ({
        records: [{ uuid: 'e1', source_node_uuid: 'a', target_node_uuid: 'b' }] as RecordLike[],
        keys: [],
        summary: null
      }),
      calls
    );

    const edges = await ops.edgeFulltextSearch(driver, 'knows', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("db.idx.fulltext.queryRelationships('RELATES_TO'");
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    expect(calls[0]?.params.query).toBe(buildFulltextQuery('knows', ['g1']));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.uuid).toBe('e1');
  });

  test('episode fulltext search uses the FalkorDB fulltext procedure', async () => {
    const calls: CapturedCall[] = [];
    const ops = new FalkorSearchOperations();
    const driver = capturingDriver(
      async () => ({ records: [{ uuid: 'ep1', name: 'ep' }] as RecordLike[], keys: [], summary: null }),
      calls
    );

    const episodes = await ops.episodeFulltextSearch(driver, 'alice', emptyFilter, ['g1'], 5);

    expect(calls[0]?.query).toContain("db.idx.fulltext.queryNodes('Episodic'");
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    expect(episodes).toHaveLength(1);
  });

  test('community fulltext search uses the FalkorDB fulltext procedure', async () => {
    const calls: CapturedCall[] = [];
    const ops = new FalkorSearchOperations();
    const driver = capturingDriver(
      async () => ({ records: [{ uuid: 'c1', name: 'c' }] as RecordLike[], keys: [], summary: null }),
      calls
    );

    const communities = await ops.communityFulltextSearch(driver, 'alice', ['g1'], 5);

    expect(calls[0]?.query).toContain("db.idx.fulltext.queryNodes('Community'");
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    expect(communities).toHaveLength(1);
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

interface CapturedCall {
  query: string;
  params: Record<string, unknown>;
}

const emptyFilter: SearchFilters = {};

function capturingDriver(
  handler: (query: string, options?: QueryOptions) => Promise<QueryResult<RecordLike>>,
  calls: CapturedCall[]
): GraphDriver {
  return {
    provider: 'falkordb',
    default_group_id: '',
    database: 'default_db',
    async executeQuery(query: string, options?: QueryOptions) {
      calls.push({ query, params: (options?.params ?? {}) as Record<string, unknown> });
      return handler(query, options) as Promise<QueryResult<never>>;
    },
    session() {
      throw new Error('not implemented');
    },
    transaction() {
      throw new Error('not implemented');
    },
    async close() {},
    async deleteAllIndexes() {},
    async buildIndicesAndConstraints() {}
  } as unknown as GraphDriver;
}

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
    if (query.includes("db.idx.fulltext.queryNodes('Entity'")) {
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

    if (query.includes("db.idx.fulltext.queryRelationships('RELATES_TO'")) {
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
