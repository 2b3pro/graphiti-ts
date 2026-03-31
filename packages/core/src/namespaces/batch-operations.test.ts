import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type {
  AsyncDisposableTransaction,
  GraphDriver,
  GraphDriverSession,
  QueryOptions,
  QueryResult
} from '../contracts';
import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { EntityNodeNamespace, EpisodeNodeNamespace } from './nodes';
import { EntityEdgeNamespace, EpisodicEdgeNamespace } from './edges';

class FakeTransaction implements AsyncDisposableTransaction {
  committed = false;
  rolledBack = false;

  async run<RecordShape = unknown>(): Promise<QueryResult<RecordShape>> {
    return { records: [] };
  }

  async commit(): Promise<void> {
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }
}

class BatchTestDriver implements GraphDriver {
  readonly provider = 'neo4j';
  readonly default_group_id = '';
  readonly database = 'neo4j';
  calls: Array<{ cypherQuery: string; options?: QueryOptions }> = [];

  private entityNodeRecords: Record<string, unknown>[] = [];
  private episodeNodeRecords: Record<string, unknown>[] = [];
  private entityEdgeRecords: Record<string, unknown>[] = [];

  constructor(
    options?: {
      entityNodes?: Record<string, unknown>[];
      episodeNodes?: Record<string, unknown>[];
      entityEdges?: Record<string, unknown>[];
    }
  ) {
    this.entityNodeRecords = options?.entityNodes ?? [];
    this.episodeNodeRecords = options?.episodeNodes ?? [];
    this.entityEdgeRecords = options?.entityEdges ?? [];
  }

  async executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options?: QueryOptions
  ): Promise<QueryResult<RecordShape>> {
    this.calls.push(options ? { cypherQuery, options } : { cypherQuery });

    if (cypherQuery.includes('MATCH (n:Entity)') && cypherQuery.includes('n.uuid IN $uuids')) {
      const uuids = (options?.params?.uuids as string[]) ?? [];
      const filtered = this.entityNodeRecords.filter((r) =>
        uuids.includes(r.uuid as string)
      );
      return { records: filtered as RecordShape[] };
    }

    if (cypherQuery.includes('MATCH (n:Entity)') && cypherQuery.includes('n.group_id IN $group_ids')) {
      const groupIds = (options?.params?.group_ids as string[]) ?? [];
      const filtered = this.entityNodeRecords.filter((r) =>
        groupIds.includes(r.group_id as string)
      );
      return { records: filtered as RecordShape[] };
    }

    if (cypherQuery.includes('MATCH (n:Episodic)') && cypherQuery.includes('n.uuid IN $uuids')) {
      const uuids = (options?.params?.uuids as string[]) ?? [];
      const filtered = this.episodeNodeRecords.filter((r) =>
        uuids.includes(r.uuid as string)
      );
      return { records: filtered as RecordShape[] };
    }

    if (cypherQuery.includes('MATCH (source:Entity)-[e:RELATES_TO]') && cypherQuery.includes('e.uuid IN $uuids')) {
      const uuids = (options?.params?.uuids as string[]) ?? [];
      const filtered = this.entityEdgeRecords.filter((r) =>
        uuids.includes(r.uuid as string)
      );
      return { records: filtered as RecordShape[] };
    }

    return { records: [] };
  }

  session(): GraphDriverSession {
    throw new Error('not used in tests');
  }

  transaction(): AsyncDisposableTransaction {
    return new FakeTransaction();
  }

  async close(): Promise<void> {}
  async deleteAllIndexes(): Promise<void> {}
  async buildIndicesAndConstraints(): Promise<void> {}
}

describe('EntityNodeNamespace batch operations', () => {
  const now = utcNow();

  const makeNode = (uuid: string, name: string, groupId = 'group'): EntityNode => ({
    uuid,
    name,
    group_id: groupId,
    labels: ['Person'],
    created_at: now,
    summary: `${name} summary`
  });

  test('saveBulk saves multiple entity nodes', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityNodeNamespace(driver);

    const nodes = [makeNode('n1', 'Alice'), makeNode('n2', 'Bob')];
    const result = await ns.saveBulk(nodes);

    expect(result).toHaveLength(2);
    expect(result[0]?.uuid).toBe('n1');
    expect(result[1]?.uuid).toBe('n2');
    const mergeCalls = driver.calls.filter((c) => c.cypherQuery.includes('MERGE'));
    expect(mergeCalls).toHaveLength(2);
  });

  test('saveBulk returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityNodeNamespace(driver);

    const result = await ns.saveBulk([]);
    expect(result).toHaveLength(0);
    expect(driver.calls).toHaveLength(0);
  });

  test('getByUuids returns matching entity nodes', async () => {
    const driver = new BatchTestDriver({
      entityNodes: [
        { uuid: 'n1', name: 'Alice', group_id: 'group', labels: ['Entity', 'Person'], created_at: now.toISOString(), summary: 'alice', name_embedding: null, attributes: {} },
        { uuid: 'n2', name: 'Bob', group_id: 'group', labels: ['Entity', 'Person'], created_at: now.toISOString(), summary: 'bob', name_embedding: null, attributes: {} },
        { uuid: 'n3', name: 'Carol', group_id: 'group', labels: ['Entity', 'Person'], created_at: now.toISOString(), summary: 'carol', name_embedding: null, attributes: {} }
      ]
    });
    const ns = new EntityNodeNamespace(driver);

    const result = await ns.getByUuids(['n1', 'n3']);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.name)).toEqual(['Alice', 'Carol']);
  });

  test('getByUuids returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityNodeNamespace(driver);

    const result = await ns.getByUuids([]);
    expect(result).toHaveLength(0);
    expect(driver.calls).toHaveLength(0);
  });

  test('getByGroupIds returns matching entity nodes', async () => {
    const driver = new BatchTestDriver({
      entityNodes: [
        { uuid: 'n1', name: 'Alice', group_id: 'g1', labels: ['Entity'], created_at: now.toISOString(), summary: '', name_embedding: null, attributes: {} },
        { uuid: 'n2', name: 'Bob', group_id: 'g2', labels: ['Entity'], created_at: now.toISOString(), summary: '', name_embedding: null, attributes: {} }
      ]
    });
    const ns = new EntityNodeNamespace(driver);

    const result = await ns.getByGroupIds(['g1']);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Alice');
  });

  test('getByGroupIds returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityNodeNamespace(driver);

    const result = await ns.getByGroupIds([]);
    expect(result).toHaveLength(0);
    expect(driver.calls).toHaveLength(0);
  });
});

describe('EpisodeNodeNamespace batch operations', () => {
  const now = utcNow();

  const makeEpisode = (uuid: string): EpisodicNode => ({
    uuid,
    name: `episode-${uuid}`,
    group_id: 'group',
    labels: [],
    created_at: now,
    source: 'text',
    source_description: 'chat',
    content: `content ${uuid}`,
    entity_edges: []
  });

  test('saveBulk saves multiple episode nodes', async () => {
    const driver = new BatchTestDriver();
    const ns = new EpisodeNodeNamespace(driver);

    const nodes = [makeEpisode('e1'), makeEpisode('e2')];
    const result = await ns.saveBulk(nodes);

    expect(result).toHaveLength(2);
    const mergeCalls = driver.calls.filter((c) => c.cypherQuery.includes('MERGE'));
    expect(mergeCalls).toHaveLength(2);
  });

  test('saveBulk returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EpisodeNodeNamespace(driver);

    const result = await ns.saveBulk([]);
    expect(result).toHaveLength(0);
  });

  test('getByUuids returns matching episode nodes', async () => {
    const driver = new BatchTestDriver({
      episodeNodes: [
        { uuid: 'e1', name: 'ep1', group_id: 'group', labels: ['Episodic'], created_at: now.toISOString(), source: 'text', source_description: 'chat', content: 'content 1', valid_at: null, entity_edges: [] },
        { uuid: 'e2', name: 'ep2', group_id: 'group', labels: ['Episodic'], created_at: now.toISOString(), source: 'text', source_description: 'chat', content: 'content 2', valid_at: null, entity_edges: ['edge-1'] }
      ]
    });
    const ns = new EpisodeNodeNamespace(driver);

    const result = await ns.getByUuids(['e1', 'e2']);
    expect(result).toHaveLength(2);
    expect(result[0]?.uuid).toBe('e1');
    expect(result[1]?.entity_edges).toEqual(['edge-1']);
  });

  test('getByUuids returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EpisodeNodeNamespace(driver);

    const result = await ns.getByUuids([]);
    expect(result).toHaveLength(0);
  });
});

describe('EntityEdgeNamespace batch operations', () => {
  const now = utcNow();

  const makeEdge = (uuid: string): EntityEdge => ({
    uuid,
    group_id: 'group',
    source_node_uuid: 'node-1',
    target_node_uuid: 'node-2',
    created_at: now,
    name: 'relates_to',
    fact: `fact ${uuid}`,
    episodes: []
  });

  test('saveBulk saves multiple entity edges', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityEdgeNamespace(driver);

    const edges = [makeEdge('edge-1'), makeEdge('edge-2')];
    const result = await ns.saveBulk(edges);

    expect(result).toHaveLength(2);
    const mergeCalls = driver.calls.filter((c) => c.cypherQuery.includes('MERGE'));
    expect(mergeCalls).toHaveLength(2);
  });

  test('saveBulk returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityEdgeNamespace(driver);

    const result = await ns.saveBulk([]);
    expect(result).toHaveLength(0);
  });

  test('getByUuids returns matching entity edges', async () => {
    const driver = new BatchTestDriver({
      entityEdges: [
        { uuid: 'edge-1', group_id: 'group', source_node_uuid: 'n1', target_node_uuid: 'n2', created_at: now.toISOString(), name: 'knows', fact: 'A knows B', fact_embedding: null, episodes: [], expired_at: null, valid_at: null, invalid_at: null },
        { uuid: 'edge-2', group_id: 'group', source_node_uuid: 'n2', target_node_uuid: 'n3', created_at: now.toISOString(), name: 'works_with', fact: 'B works with C', fact_embedding: null, episodes: [], expired_at: null, valid_at: null, invalid_at: null }
      ]
    });
    const ns = new EntityEdgeNamespace(driver);

    const result = await ns.getByUuids(['edge-1', 'edge-2']);
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('knows');
    expect(result[1]?.fact).toBe('B works with C');
  });

  test('getByUuids returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityEdgeNamespace(driver);

    const result = await ns.getByUuids([]);
    expect(result).toHaveLength(0);
  });
});

describe('EpisodicEdgeNamespace batch operations', () => {
  const now = utcNow();

  const makeEdge = (uuid: string): EpisodicEdge => ({
    uuid,
    group_id: 'group',
    source_node_uuid: 'episode-1',
    target_node_uuid: 'entity-1',
    created_at: now
  });

  test('saveBulk saves multiple episodic edges', async () => {
    const driver = new BatchTestDriver();
    const ns = new EpisodicEdgeNamespace(driver);

    const edges = [makeEdge('ee-1'), makeEdge('ee-2'), makeEdge('ee-3')];
    const result = await ns.saveBulk(edges);

    expect(result).toHaveLength(3);
    const mergeCalls = driver.calls.filter((c) => c.cypherQuery.includes('MERGE'));
    expect(mergeCalls).toHaveLength(3);
  });

  test('saveBulk returns empty array for empty input', async () => {
    const driver = new BatchTestDriver();
    const ns = new EpisodicEdgeNamespace(driver);

    const result = await ns.saveBulk([]);
    expect(result).toHaveLength(0);
  });
});

describe('EntityNodeNamespace deleteByUuids', () => {
  test('deleteByUuids issues batch delete query', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityNodeNamespace(driver);

    await ns.deleteByUuids(['n1', 'n2']);
    const deleteCalls = driver.calls.filter((c) => c.cypherQuery.includes('DETACH DELETE'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.options?.params?.uuids).toEqual(['n1', 'n2']);
  });

  test('deleteByUuids does nothing for empty array', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityNodeNamespace(driver);

    await ns.deleteByUuids([]);
    expect(driver.calls).toHaveLength(0);
  });
});

describe('EpisodeNodeNamespace deleteByUuids', () => {
  test('deleteByUuids issues batch delete query', async () => {
    const driver = new BatchTestDriver();
    const ns = new EpisodeNodeNamespace(driver);

    await ns.deleteByUuids(['e1', 'e2']);
    const deleteCalls = driver.calls.filter((c) => c.cypherQuery.includes('DETACH DELETE'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.options?.params?.uuids).toEqual(['e1', 'e2']);
  });

  test('deleteByUuids does nothing for empty array', async () => {
    const driver = new BatchTestDriver();
    const ns = new EpisodeNodeNamespace(driver);

    await ns.deleteByUuids([]);
    expect(driver.calls).toHaveLength(0);
  });
});

describe('EntityEdgeNamespace deleteByUuids', () => {
  test('deleteByUuids issues batch delete query', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityEdgeNamespace(driver);

    await ns.deleteByUuids(['edge-1', 'edge-2']);
    const deleteCalls = driver.calls.filter((c) => c.cypherQuery.includes('DELETE'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.options?.params?.uuids).toEqual(['edge-1', 'edge-2']);
  });

  test('deleteByUuids does nothing for empty array', async () => {
    const driver = new BatchTestDriver();
    const ns = new EntityEdgeNamespace(driver);

    await ns.deleteByUuids([]);
    expect(driver.calls).toHaveLength(0);
  });
});
