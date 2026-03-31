import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import { FalkorDriver } from './falkordb-driver';

describe('FalkorDriver', () => {
  test('routes read queries to roQuery', async () => {
    const graph = new FakeGraph();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new FakeFalkorClient(graph)
    );

    await driver.executeQuery('MATCH (n) RETURN n', {
      params: { limit: 1 },
      routing: 'r'
    });

    expect(graph.roQueries).toEqual([
      {
        query: 'MATCH (n) RETURN n',
        params: { limit: 1 }
      }
    ]);
    expect(graph.queries).toHaveLength(0);
  });

  test('builds minimal indices', async () => {
    const graph = new FakeGraph();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new FakeFalkorClient(graph)
    );

    await driver.buildIndicesAndConstraints();

    expect(graph.indexCalls).toContain('node-range:Entity:uuid');
    expect(graph.indexCalls).toContain('node-range:Episodic:uuid');
    expect(graph.indexCalls).toContain('edge-range:RELATES_TO:uuid');
  });

  test('returns a session backed by the selected graph', async () => {
    const graph = new FakeGraph();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379
      },
      new FakeFalkorClient(graph)
    );

    const session = driver.session();
    await session.executeQuery('RETURN 1');

    expect(graph.queries).toEqual([{ query: 'RETURN 1' }]);
  });

  test('exposes concrete entity operations for Falkor-backed saves', async () => {
    const graph = new FakeGraph();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new FakeFalkorClient(graph)
    );

    await driver.entityNodeOps.save(driver, {
      uuid: 'entity-1',
      name: 'Alice',
      group_id: 'group',
      labels: ['Person'],
      created_at: utcNow(),
      summary: 'summary'
    });

    await driver.entityEdgeOps.save(driver, {
      uuid: 'edge-1',
      group_id: 'group',
      source_node_uuid: 'entity-1',
      target_node_uuid: 'entity-2',
      created_at: utcNow(),
      name: 'knows',
      fact: 'Alice knows Bob',
      episodes: []
    });

    expect(graph.queries).toHaveLength(2);
    expect(graph.queries[0]?.query).toContain('MERGE (n:Entity {uuid: $entity.uuid})');
    expect(graph.queries[0]?.params?.labels).toEqual(['Entity', 'Person']);
    expect(graph.queries[1]?.query).toContain('MERGE (source)-[e:RELATES_TO {uuid: $edge.uuid}]->(target)');
    expect(graph.queries[1]?.params?.source_uuid).toBe('entity-1');
  });

  test('exposes concrete episode operations for Falkor-backed saves', async () => {
    const graph = new FakeGraph();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new FakeFalkorClient(graph)
    );

    await driver.episodeNodeOps.save(driver, {
      uuid: 'episode-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Alice appeared',
      valid_at: utcNow(),
      entity_edges: ['edge-1']
    });

    await driver.episodicEdgeOps.save(driver, {
      uuid: 'episode-1:entity-1',
      group_id: 'group',
      source_node_uuid: 'episode-1',
      target_node_uuid: 'entity-1',
      created_at: utcNow()
    });

    expect(graph.queries).toHaveLength(2);
    expect(graph.queries[0]?.query).toContain('MERGE (n:Episodic {uuid: $episode.uuid})');
    expect(graph.queries[1]?.query).toContain('MERGE (episode)-[e:MENTIONS {uuid: $edge.uuid}]->(entity)');
    expect(graph.queries[1]?.params?.episode_uuid).toBe('episode-1');
    expect(graph.queries[1]?.params?.entity_uuid).toBe('entity-1');
  });
});

class FakeFalkorClient {
  constructor(private readonly graph: FakeGraph) {}

  selectGraph(_graphId: string): FakeGraph {
    return this.graph;
  }

  async close(): Promise<void> {}
}

class FakeGraph {
  queries: Array<{ query: string; params?: Record<string, unknown> }> = [];
  roQueries: Array<{ query: string; params?: Record<string, unknown> }> = [];
  indexCalls: string[] = [];

  async query<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (options?.params) {
      this.queries.push({ query, params: options.params });
    } else {
      this.queries.push({ query });
    }
    return { data: [], headers: [] };
  }

  async roQuery<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (options?.params) {
      this.roQueries.push({ query, params: options.params });
    } else {
      this.roQueries.push({ query });
    }
    return { data: [], headers: [] };
  }

  async createNodeRangeIndex(label: string, ...properties: string[]): Promise<void> {
    this.indexCalls.push(`node-range:${label}:${properties.join(',')}`);
  }

  async createNodeFulltextIndex(label: string, ...properties: string[]): Promise<void> {
    this.indexCalls.push(`node-fulltext:${label}:${properties.join(',')}`);
  }

  async createEdgeRangeIndex(label: string, ...properties: string[]): Promise<void> {
    this.indexCalls.push(`edge-range:${label}:${properties.join(',')}`);
  }

  async createEdgeFulltextIndex(label: string, ...properties: string[]): Promise<void> {
    this.indexCalls.push(`edge-fulltext:${label}:${properties.join(',')}`);
  }

  async delete(): Promise<void> {}
}
