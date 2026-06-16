import { describe, expect, test } from 'bun:test';

import type { GraphDriver, QueryOptions, QueryResult } from '../../contracts';
import type { SearchFilters } from '../../search/filters';
import { buildFulltextQuery } from '../../utils/text';
import type { RecordLike } from '../../utils/records';
import { Neo4jSearchOperations } from './neo4j-search-operations';

type Handler = (query: string, options?: QueryOptions) => Promise<QueryResult<RecordLike>>;

interface CapturedCall {
  query: string;
  params: Record<string, unknown>;
}

function fakeDriver(handler: Handler, calls: CapturedCall[]): GraphDriver {
  return {
    provider: 'neo4j',
    default_group_id: '',
    database: 'neo4j',
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

const emptyFilter: SearchFilters = {};

describe('Neo4jSearchOperations.nodeFulltextSearch', () => {
  test('queries the fulltext index with the sanitized query, ordered by score', async () => {
    const calls: CapturedCall[] = [];
    const ops = new Neo4jSearchOperations();
    const driver = fakeDriver(
      async () => ({
        records: [{ uuid: 'n1', name: 'Advisorium' }] as RecordLike[],
        keys: [],
        summary: null
      }),
      calls
    );

    const nodes = await ops.nodeFulltextSearch(driver, 'Advisorium (is)', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('db.index.fulltext.queryNodes');
    expect(calls[0]?.query).toContain('node_name_and_summary');
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    // raw query has Lucene-special parens that must be escaped before hitting the index
    expect(calls[0]?.params.query).toBe(buildFulltextQuery('Advisorium (is)', ['g1']));
    expect(calls[0]?.params.group_ids).toEqual(['g1']);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.uuid).toBe('n1');
  });

  test('returns empty without touching the database for a blank query', async () => {
    const calls: CapturedCall[] = [];
    const ops = new Neo4jSearchOperations();
    const driver = fakeDriver(async () => ({ records: [], keys: [], summary: null }), calls);

    const nodes = await ops.nodeFulltextSearch(driver, '   ', emptyFilter, ['g1'], 5);

    expect(nodes).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('falls back to a CONTAINS scan when the fulltext index is missing', async () => {
    const calls: CapturedCall[] = [];
    const ops = new Neo4jSearchOperations();
    const driver = fakeDriver(async (query) => {
      if (query.includes('db.index.fulltext.queryNodes')) {
        throw new Error(
          "Failed to invoke procedure `db.index.fulltext.queryNodes`: there is no such fulltext schema index: node_name_and_summary"
        );
      }
      return {
        records: [{ uuid: 'n1', name: 'Advisorium' }] as RecordLike[],
        keys: [],
        summary: null
      };
    }, calls);

    const nodes = await ops.nodeFulltextSearch(driver, 'Advisorium', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain('db.index.fulltext.queryNodes');
    expect(calls[1]?.query).toContain('CONTAINS');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.uuid).toBe('n1');
  });
});

describe('Neo4jSearchOperations.edgeFulltextSearch', () => {
  test('queries the relationship fulltext index with the sanitized query', async () => {
    const calls: CapturedCall[] = [];
    const ops = new Neo4jSearchOperations();
    const driver = fakeDriver(
      async () => ({
        records: [
          { uuid: 'e1', source_node_uuid: 'a', target_node_uuid: 'b' }
        ] as RecordLike[],
        keys: [],
        summary: null
      }),
      calls
    );

    const edges = await ops.edgeFulltextSearch(driver, 'Advisorium is', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('db.index.fulltext.queryRelationships');
    expect(calls[0]?.query).toContain('edge_name_and_fact');
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    expect(calls[0]?.params.query).toBe(buildFulltextQuery('Advisorium is', ['g1']));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.uuid).toBe('e1');
  });
});

describe('Neo4jSearchOperations.episodeFulltextSearch', () => {
  test('queries the episode fulltext index, ordered by score', async () => {
    const calls: CapturedCall[] = [];
    const ops = new Neo4jSearchOperations();
    const driver = fakeDriver(
      async () => ({ records: [{ uuid: 'ep1', name: 'ep' }] as RecordLike[], keys: [], summary: null }),
      calls
    );

    const episodes = await ops.episodeFulltextSearch(driver, 'Advisorium', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('db.index.fulltext.queryNodes');
    expect(calls[0]?.query).toContain('episode_content');
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    expect(calls[0]?.params.query).toBe(buildFulltextQuery('Advisorium', ['g1']));
    expect(episodes).toHaveLength(1);
  });

  test('falls back to a CONTAINS scan when the fulltext index is missing', async () => {
    const calls: CapturedCall[] = [];
    const ops = new Neo4jSearchOperations();
    const driver = fakeDriver(async (query) => {
      if (query.includes('db.index.fulltext.queryNodes')) {
        throw new Error('there is no such fulltext schema index: episode_content');
      }
      return { records: [{ uuid: 'ep1', name: 'ep' }] as RecordLike[], keys: [], summary: null };
    }, calls);

    const episodes = await ops.episodeFulltextSearch(driver, 'Advisorium', emptyFilter, ['g1'], 5);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.query).toContain('CONTAINS');
    expect(episodes).toHaveLength(1);
  });
});

describe('Neo4jSearchOperations.communityFulltextSearch', () => {
  test('queries the community fulltext index, ordered by score', async () => {
    const calls: CapturedCall[] = [];
    const ops = new Neo4jSearchOperations();
    const driver = fakeDriver(
      async () => ({ records: [{ uuid: 'c1', name: 'c' }] as RecordLike[], keys: [], summary: null }),
      calls
    );

    const communities = await ops.communityFulltextSearch(driver, 'Advisorium', ['g1'], 5);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain('db.index.fulltext.queryNodes');
    expect(calls[0]?.query).toContain('community_name');
    expect(calls[0]?.query).toContain('ORDER BY score DESC');
    expect(calls[0]?.params.query).toBe(buildFulltextQuery('Advisorium', ['g1']));
    expect(communities).toHaveLength(1);
  });
});
