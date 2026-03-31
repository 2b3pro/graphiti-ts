import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { utcNow } from '@graphiti/shared';

import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { Graphiti } from '../graphiti';
import type {
  EpisodeExtractionContext,
  EpisodeExtractionResult,
  EpisodeExtractor
} from '../ingest/extractor';
import { createNeo4jClientAdapter, Neo4jDriver } from './neo4j-driver';

const hasNeo4jEnv =
  Boolean(process.env.NEO4J_URI) &&
  Boolean(process.env.NEO4J_USER) &&
  Boolean(process.env.NEO4J_PASSWORD);

const integrationTest = hasNeo4jEnv ? test : test.skip;

describe('Neo4j integration', () => {
  let graphiti: Graphiti | null = null;
  let setupSucceeded = false;
  const groupId = `ts-port-${randomUUID()}`;
  const allGroupIds = [groupId];
  const entityUuid = `entity-${randomUUID()}`;
  const episodeUuid = `episode-${randomUUID()}`;
  const edgeUuid = `edge-${randomUUID()}`;
  const mentionUuid = `mention-${randomUUID()}`;

  function testGroupId(): string {
    const id = `ts-port-${randomUUID()}`;
    allGroupIds.push(id);
    return id;
  }

  beforeAll(async () => {
    if (!hasNeo4jEnv) {
      return;
    }

    const driver = new Neo4jDriver(
      {
        uri: process.env.NEO4J_URI!,
        user: process.env.NEO4J_USER!,
        password: process.env.NEO4J_PASSWORD!,
        database: process.env.NEO4J_DATABASE ?? 'neo4j'
      },
      createNeo4jClientAdapter({
        uri: process.env.NEO4J_URI!,
        user: process.env.NEO4J_USER!,
        password: process.env.NEO4J_PASSWORD!,
        database: process.env.NEO4J_DATABASE ?? 'neo4j'
      })
    );

    try {
      await Promise.race([
        driver.healthCheck(),
        createTimeout(10000, 'Neo4j health check timed out')
      ]);
      graphiti = new Graphiti({ driver });
      await Promise.race([
        graphiti.buildIndicesAndConstraints(),
        createTimeout(10000, 'Neo4j setup timed out')
      ]);
      setupSucceeded = true;
    } catch {
      await driver.close();
      graphiti = null;
      setupSucceeded = false;
    }
  });

  afterAll(async () => {
    if (!graphiti) {
      return;
    }

    for (const gid of allGroupIds) {
      await graphiti.driver.executeQuery(
        `
          MATCH (n)
          WHERE n.group_id = $group_id
          DETACH DELETE n
        `,
        { params: { group_id: gid } }
      );
    }

    await graphiti.close();
  });

  integrationTest('persists and reloads nodes and edges against Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const activeGraphiti = graphiti!;

    const entity: EntityNode = {
      uuid: entityUuid,
      name: 'Alice',
      group_id: groupId,
      labels: ['Person'],
      created_at: utcNow(),
      summary: 'test entity'
    };
    const episode: EpisodicNode = {
      uuid: episodeUuid,
      name: 'episode',
      group_id: groupId,
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'integration test',
      content: 'Alice knows Bob',
      valid_at: utcNow(),
      entity_edges: [edgeUuid]
    };
    const otherEntity: EntityNode = {
      uuid: `entity-${randomUUID()}`,
      name: 'Bob',
      group_id: groupId,
      labels: ['Person'],
      created_at: utcNow(),
      summary: 'test entity'
    };
    const edge: EntityEdge = {
      uuid: edgeUuid,
      group_id: groupId,
      source_node_uuid: entity.uuid,
      target_node_uuid: otherEntity.uuid,
      created_at: utcNow(),
      name: 'knows',
      fact: 'Alice knows Bob',
      episodes: [episode.uuid]
    };
    const mention: EpisodicEdge = {
      uuid: mentionUuid,
      group_id: groupId,
      source_node_uuid: episode.uuid,
      target_node_uuid: entity.uuid,
      created_at: utcNow()
    };

    await activeGraphiti.nodes.entity.save(entity);
    await activeGraphiti.nodes.entity.save(otherEntity);
    await activeGraphiti.nodes.episode.save(episode);
    await activeGraphiti.edges.entity.save(edge);
    await activeGraphiti.edges.episodic.save(mention);

    const loadedEntity = await activeGraphiti.nodes.entity.getByUuid(entity.uuid);
    const loadedEpisode = await activeGraphiti.nodes.episode.getByUuid(episode.uuid);
    const loadedEdge = await activeGraphiti.edges.entity.getByUuid(edge.uuid);

    expect(loadedEntity.name).toBe('Alice');
    expect(loadedEntity.labels).toContain('Person');
    expect(loadedEpisode.entity_edges).toContain(edge.uuid);
    expect(loadedEdge.fact).toBe('Alice knows Bob');
    expect(loadedEdge.source_node_uuid).toBe(entity.uuid);
    expect(loadedEdge.target_node_uuid).toBe(otherEntity.uuid);
  });

  integrationTest('ingests a raw episode against Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const ingestGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      })
    });
    const ingestEpisodeUuid = `episode-${randomUUID()}`;
    const ingestEpisode: EpisodicNode = {
      uuid: ingestEpisodeUuid,
      name: 'episode',
      group_id: tgid,
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'integration test',
      content: 'Alice knows Bob',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = await ingestGraphiti.ingestEpisode({
      episode: ingestEpisode
    });

    expect(result.nodes.map((node) => node.name).sort()).toEqual(['Alice', 'Bob']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.fact).toBe('Alice knows Bob');

    const persisted = await activeGraphiti.driver.executeQuery<{
      edge_count: number;
      episode_count: number;
      entity_count: number;
    }>(
      `
        MATCH (episode:Episodic {uuid: $episode_uuid, group_id: $group_id})
        OPTIONAL MATCH (entity:Entity {group_id: $group_id})
        WITH episode, count(DISTINCT entity) AS entity_count
        OPTIONAL MATCH (:Entity {group_id: $group_id})-[edge:RELATES_TO {group_id: $group_id}]->(:Entity {group_id: $group_id})
        RETURN
          count(DISTINCT episode) AS episode_count,
          entity_count AS entity_count,
          count(DISTINCT edge) AS edge_count
      `,
      {
        params: {
          episode_uuid: ingestEpisodeUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.episode_count).toBe(1);
    expect(persisted.records[0]?.entity_count).toBeGreaterThanOrEqual(2);
    expect(persisted.records[0]?.edge_count).toBeGreaterThanOrEqual(1);
  });

  integrationTest('preserves temporal contradictions across batch ingest in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const temporalGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new ContradictingEpisodeExtractor()
    });
    const olderTime = new Date('2026-03-29T12:00:00.000Z');
    const newerTime = new Date('2026-03-30T12:00:00.000Z');
    const olderEpisodeUuid = `episode-${randomUUID()}`;
    const newerEpisodeUuid = `episode-${randomUUID()}`;

    const result = await temporalGraphiti.ingestEpisodes({
      episodes: [
        {
          episode: {
            uuid: newerEpisodeUuid,
            name: 'newer episode',
            group_id: tgid,
            labels: [],
            created_at: newerTime,
            source: 'text',
            source_description: 'integration test',
            content: 'newer',
            valid_at: newerTime,
            entity_edges: []
          }
        },
        {
          episode: {
            uuid: olderEpisodeUuid,
            name: 'older episode',
            group_id: tgid,
            labels: [],
            created_at: olderTime,
            source: 'text',
            source_description: 'integration test',
            content: 'older',
            valid_at: olderTime,
            entity_edges: []
          }
        }
      ]
    });

    expect(result.episodes.map((entry) => entry.episode.uuid)).toEqual([
      olderEpisodeUuid,
      newerEpisodeUuid
    ]);

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      fact: string;
      valid_at: Date | string | null;
      invalid_at: Date | string | null;
      expired_at: Date | string | null;
    }>(
      `
        MATCH (:Entity {group_id: $group_id})-[edge:RELATES_TO {group_id: $group_id}]->(:Entity {group_id: $group_id})
        RETURN
          edge.uuid AS uuid,
          edge.fact AS fact,
          edge.valid_at AS valid_at,
          edge.invalid_at AS invalid_at,
          edge.expired_at AS expired_at
        ORDER BY edge.valid_at ASC, edge.created_at ASC
      `,
      {
        params: {
          group_id: tgid
        },
        routing: 'r'
      }
    );

    const contradictionEdges = persisted.records.filter(
      (record) =>
        record.fact === 'Alice knows Bob' || record.fact === 'Alice distrusts Bob'
    );

    expect(contradictionEdges).toHaveLength(2);

    const olderEdge = contradictionEdges.find((record) => record.fact === 'Alice knows Bob');
    const newerEdge = contradictionEdges.find((record) => record.fact === 'Alice distrusts Bob');

    expect(String(olderEdge?.valid_at)).toContain('2026-03-29');
    expect(String(olderEdge?.invalid_at)).toContain('2026-03-30');
    expect(String(olderEdge?.expired_at)).toContain('2026-03-30');
    expect(String(newerEdge?.valid_at)).toContain('2026-03-30');
    expect(newerEdge?.invalid_at).toBeNull();
  });

  integrationTest('reuses persisted alias metadata across episodes in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliasGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new AliasAwareEpisodeExtractor()
    });
    const canonicalTime = new Date('2026-03-28T12:00:00.000Z');
    const aliasTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await aliasGraphiti.ingestEpisodes({
      episodes: [
        {
          episode: {
            uuid: `episode-${randomUUID()}`,
            name: 'canonical episode',
            group_id: tgid,
            labels: [],
            created_at: canonicalTime,
            source: 'text',
            source_description: 'integration test',
            content: 'canonical',
            valid_at: canonicalTime,
            entity_edges: []
          }
        },
        {
          episode: {
            uuid: `episode-${randomUUID()}`,
            name: 'alias episode',
            group_id: tgid,
            labels: [],
            created_at: aliasTime,
            source: 'text',
            source_description: 'integration test',
            content: 'alias',
            valid_at: aliasTime,
            entity_edges: []
          }
        }
      ]
    });

    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[1]?.nodes.map((node) => node.name).sort()).toEqual(['Alice', 'Bob']);

    const persisted = await activeGraphiti.driver.executeQuery<{
      name: string;
      attributes: Record<string, unknown> | null;
      episode_count: number;
    }>(
      `
        MATCH (entity:Entity {group_id: $group_id})
        OPTIONAL MATCH (entity)-[edge:RELATES_TO {group_id: $group_id}]->(:Entity {group_id: $group_id})
        RETURN
          entity.name AS name,
          entity.attributes AS attributes,
          count(DISTINCT edge) AS episode_count
        ORDER BY entity.name ASC
      `,
      {
        params: {
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records.map((record) => record.name)).toEqual(['Alice', 'Bob']);
    expect(persisted.records[0]?.attributes?.aliases).toEqual(['AJ']);
  });

  integrationTest('uses relationship context to resolve ambiguous same-name entities in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const ambiguousGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alex', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alex knows Bob'
        }
      })
    });
    const alexBobUuid = `entity-${randomUUID()}`;
    const alexCarolUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const carolUuid = `entity-${randomUUID()}`;
    const setupTime = new Date('2026-03-27T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: alexBobUuid,
      name: 'Alex',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Alex who knows Bob'
    });
    await activeGraphiti.nodes.entity.save({
      uuid: alexCarolUuid,
      name: 'Alex',
      group_id: tgid,
      labels: ['Person'],
      created_at: new Date('2026-03-27T12:01:00.000Z'),
      summary: 'Alex who knows Carol'
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Bob'
    });
    await activeGraphiti.nodes.entity.save({
      uuid: carolUuid,
      name: 'Carol',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Carol'
    });
    await activeGraphiti.edges.entity.save({
      uuid: `edge-${randomUUID()}`,
      group_id: tgid,
      source_node_uuid: alexBobUuid,
      target_node_uuid: bobUuid,
      created_at: setupTime,
      valid_at: setupTime,
      name: 'knows',
      fact: 'Alex knows Bob',
      episodes: []
    });
    await activeGraphiti.edges.entity.save({
      uuid: `edge-${randomUUID()}`,
      group_id: tgid,
      source_node_uuid: alexCarolUuid,
      target_node_uuid: carolUuid,
      created_at: setupTime,
      valid_at: setupTime,
      name: 'knows',
      fact: 'Alex knows Carol',
      episodes: []
    });

    const result = await ambiguousGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'ambiguous episode',
        group_id: tgid,
        labels: [],
        created_at: new Date('2026-03-28T12:00:00.000Z'),
        source: 'text',
        source_description: 'integration test',
        content: 'ambiguous',
        valid_at: new Date('2026-03-28T12:00:00.000Z'),
        entity_edges: []
      }
    });

    expect(result.nodes.map((node) => node.uuid)).toContain(alexBobUuid);
    expect(result.nodes.map((node) => node.uuid)).toContain(bobUuid);
    expect(result.nodes.map((node) => node.uuid)).not.toContain(alexCarolUuid);
    expect(result.edges[0]?.source_node_uuid).toBe(alexBobUuid);
    expect(result.edges[0]?.target_node_uuid).toBe(bobUuid);
    expect(result.edges[0]?.fact).toBe('Alex knows Bob');
  });

  integrationTest('persists attribute history for changing model-style fields in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const setupTime = new Date('2026-03-26T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Alice',
      attributes: {
        role: 'engineer'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Bob'
    });

    const historyGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      llm_client: new RoleChangingHydrationLLMClient(aliceUuid),
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      })
    });

    const result = await historyGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'role update episode',
        group_id: tgid,
        labels: [],
        created_at: new Date('2026-03-27T12:00:00.000Z'),
        source: 'text',
        source_description: 'integration test',
        content: 'role update',
        valid_at: new Date('2026-03-27T12:00:00.000Z'),
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      role: 'manager',
      role_history: ['engineer', 'manager']
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      role: 'manager',
      role_history: ['engineer', 'manager']
    });
  });

  integrationTest('persists timestamped company history in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const setupTime = new Date('2026-03-26T12:00:00.000Z');
    const updateTime = new Date('2026-03-27T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Alice',
      attributes: {
        company: 'Acme'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Bob'
    });

    const companyGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      llm_client: new CompanyChangingHydrationLLMClient(aliceUuid),
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      })
    });

    const result = await companyGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'company update episode',
        group_id: tgid,
        labels: [],
        created_at: updateTime,
        source: 'text',
        source_description: 'integration test',
        content: 'company update',
        valid_at: updateTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      company: 'Globex',
      company_history: ['Acme', 'Globex'],
      company_updated_at: updateTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      company: 'Globex',
      company_history: ['Acme', 'Globex'],
      company_updated_at: updateTime.toISOString()
    });
  });

  integrationTest('persists timestamped department history in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const setupTime = new Date('2026-03-26T12:00:00.000Z');
    const updateTime = new Date('2026-03-27T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Alice',
      attributes: {
        department: 'Engineering'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Bob'
    });

    const departmentGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      llm_client: new DepartmentChangingHydrationLLMClient(aliceUuid),
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      })
    });

    const result = await departmentGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'department update episode',
        group_id: tgid,
        labels: [],
        created_at: updateTime,
        source: 'text',
        source_description: 'integration test',
        content: 'department update',
        valid_at: updateTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      department: 'Research',
      department_history: ['Engineering', 'Research'],
      department_updated_at: updateTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      department: 'Research',
      department_history: ['Engineering', 'Research'],
      department_updated_at: updateTime.toISOString()
    });
  });

  integrationTest('persists timestamped location history in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const setupTime = new Date('2026-03-26T12:00:00.000Z');
    const updateTime = new Date('2026-03-27T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Alice',
      attributes: {
        location: 'New York'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Bob'
    });

    const locationGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      llm_client: new LocationChangingHydrationLLMClient(aliceUuid),
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      })
    });

    const result = await locationGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'location update episode',
        group_id: tgid,
        labels: [],
        created_at: updateTime,
        source: 'text',
        source_description: 'integration test',
        content: 'location update',
        valid_at: updateTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      location: 'San Francisco',
      location_history: ['New York', 'San Francisco'],
      location_updated_at: updateTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      location: 'San Francisco',
      location_history: ['New York', 'San Francisco'],
      location_updated_at: updateTime.toISOString()
    });
  });

  integrationTest('persists timestamped title history in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const setupTime = new Date('2026-03-26T12:00:00.000Z');
    const updateTime = new Date('2026-03-27T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Alice',
      attributes: {
        title: 'Engineer'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Bob'
    });

    const titleGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      llm_client: new TitleChangingHydrationLLMClient(aliceUuid),
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      })
    });

    const result = await titleGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'title update episode',
        group_id: tgid,
        labels: [],
        created_at: updateTime,
        source: 'text',
        source_description: 'integration test',
        content: 'title update',
        valid_at: updateTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      title: 'Director',
      title_history: ['Engineer', 'Director'],
      title_updated_at: updateTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      title: 'Director',
      title_history: ['Engineer', 'Director'],
      title_updated_at: updateTime.toISOString()
    });
  });

  integrationTest('persists timestamped status history in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const setupTime = new Date('2026-03-26T12:00:00.000Z');
    const updateTime = new Date('2026-03-27T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Alice',
      attributes: {
        status: 'active'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: setupTime,
      summary: 'Bob'
    });

    const statusGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      llm_client: new StatusChangingHydrationLLMClient(aliceUuid),
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      })
    });

    const result = await statusGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'status update episode',
        group_id: tgid,
        labels: [],
        created_at: updateTime,
        source: 'text',
        source_description: 'integration test',
        content: 'status update',
        valid_at: updateTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      status: 'inactive',
      status_history: ['active', 'inactive'],
      status_updated_at: updateTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      status: 'inactive',
      status_history: ['active', 'inactive'],
      status_updated_at: updateTime.toISOString()
    });
  });

  integrationTest('keeps the latest company when an older episode reports a prior employer in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const newerTime = new Date('2026-03-31T12:00:00.000Z');
    const olderTime = new Date('2026-03-29T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Alice',
      attributes: {
        company: 'Globex',
        last_seen_at: newerTime.toISOString()
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Bob'
    });

    const companyGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new CompanyChangingHydrationLLMClient(aliceUuid, 'Acme')
    });

    const result = await companyGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'historical company update episode',
        group_id: tgid,
        labels: [],
        created_at: olderTime,
        source: 'text',
        source_description: 'integration test',
        content: 'historical company update',
        valid_at: olderTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      company: 'Globex',
      company_history: ['Globex', 'Acme'],
      company_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      company: 'Globex',
      company_history: ['Globex', 'Acme'],
      company_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });
  });

  integrationTest('keeps the latest department when an older episode reports a prior team in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const newerTime = new Date('2026-03-31T12:00:00.000Z');
    const olderTime = new Date('2026-03-29T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Alice',
      attributes: {
        department: 'Research',
        last_seen_at: newerTime.toISOString()
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Bob'
    });

    const departmentGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new DepartmentChangingHydrationLLMClient(aliceUuid, 'Engineering')
    });

    const result = await departmentGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'historical department update episode',
        group_id: tgid,
        labels: [],
        created_at: olderTime,
        source: 'text',
        source_description: 'integration test',
        content: 'historical department update',
        valid_at: olderTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      department: 'Research',
      department_history: ['Research', 'Engineering'],
      department_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      department: 'Research',
      department_history: ['Research', 'Engineering'],
      department_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });
  });

  integrationTest('keeps the latest location when an older episode reports a prior city in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const newerTime = new Date('2026-03-31T12:00:00.000Z');
    const olderTime = new Date('2026-03-29T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Alice',
      attributes: {
        location: 'San Francisco',
        last_seen_at: newerTime.toISOString()
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Bob'
    });

    const locationGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new LocationChangingHydrationLLMClient(aliceUuid, 'New York')
    });

    const result = await locationGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'historical location update episode',
        group_id: tgid,
        labels: [],
        created_at: olderTime,
        source: 'text',
        source_description: 'integration test',
        content: 'historical location update',
        valid_at: olderTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      location: 'San Francisco',
      location_history: ['San Francisco', 'New York'],
      location_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      location: 'San Francisco',
      location_history: ['San Francisco', 'New York'],
      location_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });
  });

  integrationTest('keeps the latest title when an older episode reports a prior title in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const newerTime = new Date('2026-03-31T12:00:00.000Z');
    const olderTime = new Date('2026-03-29T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Alice',
      attributes: {
        title: 'Director',
        last_seen_at: newerTime.toISOString()
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Bob'
    });

    const titleGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new TitleChangingHydrationLLMClient(aliceUuid, 'Engineer')
    });

    const result = await titleGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'historical title update episode',
        group_id: tgid,
        labels: [],
        created_at: olderTime,
        source: 'text',
        source_description: 'integration test',
        content: 'historical title update',
        valid_at: olderTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      title: 'Director',
      title_history: ['Director', 'Engineer'],
      title_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      title: 'Director',
      title_history: ['Director', 'Engineer'],
      title_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });
  });

  integrationTest('keeps the latest status when an older episode reports a prior state in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const newerTime = new Date('2026-03-31T12:00:00.000Z');
    const olderTime = new Date('2026-03-29T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Alice',
      attributes: {
        status: 'inactive',
        last_seen_at: newerTime.toISOString()
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Bob'
    });

    const statusGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new StatusChangingHydrationLLMClient(aliceUuid, 'active')
    });

    const result = await statusGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'historical status update episode',
        group_id: tgid,
        labels: [],
        created_at: olderTime,
        source: 'text',
        source_description: 'integration test',
        content: 'historical status update',
        valid_at: olderTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      status: 'inactive',
      status_history: ['inactive', 'active'],
      status_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      status: 'inactive',
      status_history: ['inactive', 'active'],
      status_updated_at: newerTime.toISOString(),
      last_seen_at: newerTime.toISOString()
    });
  });

  integrationTest('keeps the latest attribute value when an older episode reports a prior role in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const newerTime = new Date('2026-03-31T12:00:00.000Z');
    const olderTime = new Date('2026-03-29T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Alice',
      attributes: {
        role: 'manager',
        last_seen_at: newerTime.toISOString()
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: newerTime,
      summary: 'Bob'
    });

    const historyGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new RoleChangingHydrationLLMClient(aliceUuid, 'engineer')
    });

    const result = await historyGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'historical role update episode',
        group_id: tgid,
        labels: [],
        created_at: olderTime,
        source: 'text',
        source_description: 'integration test',
        content: 'historical role update',
        valid_at: olderTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      role: 'manager',
      role_history: ['manager', 'engineer'],
      last_seen_at: newerTime.toISOString()
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      role: 'manager',
      role_history: ['manager', 'engineer'],
      last_seen_at: newerTime.toISOString()
    });
  });

  integrationTest('accumulates configured string-set attributes in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const eventTime = new Date('2026-03-30T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: eventTime,
      summary: 'Alice',
      attributes: {
        skills: ['python'],
        tags: 'founder'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: eventTime,
      summary: 'Bob'
    });

    const skillsGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new SkillMergingHydrationLLMClient(aliceUuid)
    });

    const result = await skillsGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'skill update episode',
        group_id: tgid,
        labels: [],
        created_at: eventTime,
        source: 'text',
        source_description: 'integration test',
        content: 'skill update',
        valid_at: eventTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      skills: ['python', 'typescript'],
      tags: ['founder', 'operator']
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      skills: ['python', 'typescript'],
      tags: ['founder', 'operator']
    });
  });

  integrationTest('accumulates configured team string-set attributes in Neo4j', async () => {
    if (!setupSucceeded || !graphiti) {
      return;
    }

    const tgid = testGroupId();
    const activeGraphiti = graphiti!;
    const aliceUuid = `entity-${randomUUID()}`;
    const bobUuid = `entity-${randomUUID()}`;
    const eventTime = new Date('2026-03-30T12:00:00.000Z');

    await activeGraphiti.nodes.entity.save({
      uuid: aliceUuid,
      name: 'Alice',
      group_id: tgid,
      labels: ['Person'],
      created_at: eventTime,
      summary: 'Alice',
      attributes: {
        teams: 'platform'
      }
    });
    await activeGraphiti.nodes.entity.save({
      uuid: bobUuid,
      name: 'Bob',
      group_id: tgid,
      labels: ['Person'],
      created_at: eventTime,
      summary: 'Bob'
    });

    const teamsGraphiti = new Graphiti({
      driver: activeGraphiti.driver,
      episode_extractor: new DeterministicEpisodeExtractor({
        entities: ['Alice', 'Bob'],
        relation: {
          name: 'knows',
          fact: 'Alice knows Bob'
        }
      }),
      llm_client: new TeamMergingHydrationLLMClient(aliceUuid)
    });

    const result = await teamsGraphiti.ingestEpisode({
      episode: {
        uuid: `episode-${randomUUID()}`,
        name: 'team update episode',
        group_id: tgid,
        labels: [],
        created_at: eventTime,
        source: 'text',
        source_description: 'integration test',
        content: 'team update',
        valid_at: eventTime,
        entity_edges: []
      }
    });

    expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
      teams: ['platform', 'research']
    });

    const persisted = await activeGraphiti.driver.executeQuery<{
      uuid: string;
      attributes: Record<string, unknown> | null;
    }>(
      `
        MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
        RETURN entity.uuid AS uuid, entity.attributes AS attributes
      `,
      {
        params: {
          uuid: aliceUuid,
          group_id: tgid
        },
        routing: 'r'
      }
    );

    expect(persisted.records[0]?.attributes).toMatchObject({
      teams: ['platform', 'research']
    });
  });

  integrationTest(
    'keeps maintained attributes when older Neo4j hydration returns null values',
    async () => {
      if (!setupSucceeded || !graphiti) {
        return;
      }

      const tgid = testGroupId();
      const activeGraphiti = graphiti!;
      const aliceUuid = `entity-${randomUUID()}`;
      const bobUuid = `entity-${randomUUID()}`;
      const newerTime = new Date('2026-03-31T12:00:00.000Z');
      const olderTime = new Date('2026-03-29T12:00:00.000Z');

      await activeGraphiti.nodes.entity.save({
        uuid: aliceUuid,
        name: 'Alice',
        group_id: tgid,
        labels: ['Person'],
        created_at: newerTime,
        summary: 'Alice',
        attributes: {
          role: 'manager',
          role_updated_at: newerTime.toISOString(),
          skills: ['python'],
          last_seen_at: newerTime.toISOString()
        }
      });
      await activeGraphiti.nodes.entity.save({
        uuid: bobUuid,
        name: 'Bob',
        group_id: tgid,
        labels: ['Person'],
        created_at: newerTime,
        summary: 'Bob'
      });

      const historyGraphiti = new Graphiti({
        driver: activeGraphiti.driver,
        episode_extractor: new DeterministicEpisodeExtractor({
          entities: ['Alice', 'Bob'],
          relation: {
            name: 'knows',
            fact: 'Alice knows Bob'
          }
        }),
        llm_client: new NullAttributeHydrationLLMClient(aliceUuid)
      });

      const result = await historyGraphiti.ingestEpisode({
        episode: {
          uuid: `episode-${randomUUID()}`,
          name: 'historical null update episode',
          group_id: tgid,
          labels: [],
          created_at: olderTime,
          source: 'text',
          source_description: 'archive',
          content: 'historical null update',
          valid_at: olderTime,
          entity_edges: []
        }
      });

      expect(result.nodes.find((node) => node.uuid === aliceUuid)?.attributes).toMatchObject({
        role: 'manager',
        role_updated_at: newerTime.toISOString(),
        skills: ['python'],
        last_seen_at: newerTime.toISOString(),
        source_description: 'archive',
        source_descriptions: ['archive']
      });

      const persisted = await activeGraphiti.driver.executeQuery<{
        uuid: string;
        attributes: Record<string, unknown> | null;
      }>(
        `
          MATCH (entity:Entity {uuid: $uuid, group_id: $group_id})
          RETURN entity.uuid AS uuid, entity.attributes AS attributes
        `,
        {
          params: {
            uuid: aliceUuid,
            group_id: tgid
          },
          routing: 'r'
        }
      );

      expect(persisted.records[0]?.attributes).toMatchObject({
        role: 'manager',
        role_updated_at: newerTime.toISOString(),
        skills: ['python'],
        last_seen_at: newerTime.toISOString(),
        source_description: 'archive',
        source_descriptions: ['archive']
      });
    }
  );

  integrationTest(
    'preserves multi-episode maintenance semantics across out-of-order batch ingest in Neo4j',
    async () => {
      if (!setupSucceeded || !graphiti) {
        return;
      }

      const tgid = testGroupId();
      const activeGraphiti = graphiti!;
      const batchGraphiti = new Graphiti({
        driver: activeGraphiti.driver,
        episode_extractor: new DeterministicEpisodeExtractor({
          entities: ['Alice', 'Bob'],
          relation: {
            name: 'knows',
            fact: 'Alice knows Bob'
          }
        }),
        llm_client: new EpisodicRoleHydrationLLMClient()
      });

      const result = await batchGraphiti.ingestEpisodes({
        episodes: [
          {
            episode: {
              uuid: `episode-${randomUUID()}`,
              name: 'newest batch episode',
              group_id: tgid,
              labels: [],
              created_at: new Date('2026-03-31T12:00:00.000Z'),
              source: 'text',
              source_description: 'chat',
              content: 'role:manager',
              valid_at: new Date('2026-03-31T12:00:00.000Z'),
              entity_edges: []
            }
          },
          {
            episode: {
              uuid: `episode-${randomUUID()}`,
              name: 'oldest batch episode',
              group_id: tgid,
              labels: [],
              created_at: new Date('2026-03-29T12:00:00.000Z'),
              source: 'text',
              source_description: 'archive',
              content: 'role:engineer',
              valid_at: new Date('2026-03-29T12:00:00.000Z'),
              entity_edges: []
            }
          },
          {
            episode: {
              uuid: `episode-${randomUUID()}`,
              name: 'middle batch episode',
              group_id: tgid,
              labels: [],
              created_at: new Date('2026-03-30T12:00:00.000Z'),
              source: 'text',
              source_description: 'email',
              content: 'role:none',
              valid_at: new Date('2026-03-30T12:00:00.000Z'),
              entity_edges: []
            }
          }
        ]
      });

      expect(result.episodes.map((entry) => entry.episode.source_description)).toEqual([
        'archive',
        'email',
        'chat'
      ]);

      const persisted = await activeGraphiti.driver.executeQuery<{
        uuid: string;
        attributes: Record<string, unknown> | null;
      }>(
        `
          MATCH (entity:Entity {group_id: $group_id, name: 'Alice'})
          RETURN entity.uuid AS uuid, entity.attributes AS attributes
          ORDER BY entity.created_at DESC
          LIMIT 1
        `,
        {
          params: {
            group_id: tgid
          },
          routing: 'r'
        }
      );

      expect(persisted.records[0]?.attributes).toMatchObject({
        role: 'manager',
        role_history: ['engineer', 'manager'],
        role_updated_at: '2026-03-31T12:00:00.000Z',
        source_description: 'chat',
        source_descriptions: ['archive', 'email', 'chat'],
        first_seen_at: '2026-03-29T12:00:00.000Z',
        last_seen_at: '2026-03-31T12:00:00.000Z'
      });
    }
  );
});

function createTimeout(durationMs: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), durationMs);
  });
}

class DeterministicEpisodeExtractor implements EpisodeExtractor {
  constructor(
    private readonly config: {
      entities: string[];
      relation: {
        name: string;
        fact: string;
      };
    }
  ) {}

  async extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult> {
    const entities = this.config.entities.map((name) => ({
      uuid: randomUUID(),
      name,
      group_id: context.episode.group_id,
      labels: ['Extracted'],
      created_at: context.episode.created_at,
      summary: ''
    }));
    const [source, target] = entities;

    return {
      entities,
      entity_edges:
        source && target
          ? [
              {
                uuid: randomUUID(),
                group_id: context.episode.group_id,
                source_node_uuid: source.uuid,
                target_node_uuid: target.uuid,
                created_at: context.episode.created_at,
                valid_at: context.episode.valid_at ?? context.episode.created_at,
                name: this.config.relation.name,
                fact: this.config.relation.fact,
                episodes: [context.episode.uuid]
              }
            ]
          : []
    };
  }
}

class ContradictingEpisodeExtractor implements EpisodeExtractor {
  async extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult> {
    const fact =
      context.episode.content === 'older' ? 'Alice knows Bob' : 'Alice distrusts Bob';

    return new DeterministicEpisodeExtractor({
      entities: ['Alice', 'Bob'],
      relation: {
        name: 'knows',
        fact
      }
    }).extract(context);
  }
}

class AliasAwareEpisodeExtractor implements EpisodeExtractor {
  async extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult> {
    const useAlias = context.episode.content === 'alias';
    const primaryName = useAlias ? 'AJ' : 'Alice';
    const aliceUuid = randomUUID();
    const bobUuid = randomUUID();

    return {
      entities: [
        {
          uuid: aliceUuid,
          name: primaryName,
          group_id: context.episode.group_id,
          labels: ['Extracted'],
          created_at: context.episode.created_at,
          summary: '',
          ...(useAlias ? {} : { attributes: { aliases: ['AJ'] } })
        },
        {
          uuid: bobUuid,
          name: 'Bob',
          group_id: context.episode.group_id,
          labels: ['Extracted'],
          created_at: context.episode.created_at,
          summary: ''
        }
      ],
      entity_edges: [
        {
          uuid: randomUUID(),
          group_id: context.episode.group_id,
          source_node_uuid: aliceUuid,
          target_node_uuid: bobUuid,
          created_at: context.episode.created_at,
          valid_at: context.episode.valid_at ?? context.episode.created_at,
          name: 'knows',
          fact: 'Alice knows Bob',
          episodes: [context.episode.uuid]
        }
      ]
    };
  }
}

class RoleChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(
    private readonly targetUuid: string,
    private readonly role: string = 'manager'
  ) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice now leads the team.',
          attributes: {
            role: this.role
          }
        }
      ]
    });
  }
}

class CompanyChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(
    private readonly targetUuid: string,
    private readonly company: string = 'Globex'
  ) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice joined Globex.',
          attributes: {
            company: this.company
          }
        }
      ]
    });
  }
}

class DepartmentChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(
    private readonly targetUuid: string,
    private readonly department: string = 'Research'
  ) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice changed departments.',
          attributes: {
            department: this.department
          }
        }
      ]
    });
  }
}

class LocationChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(
    private readonly targetUuid: string,
    private readonly location: string = 'San Francisco'
  ) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice changed locations.',
          attributes: {
            location: this.location
          }
        }
      ]
    });
  }
}

class TitleChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(
    private readonly targetUuid: string,
    private readonly title: string = 'Director'
  ) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice changed titles.',
          attributes: {
            title: this.title
          }
        }
      ]
    });
  }
}

class StatusChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(
    private readonly targetUuid: string,
    private readonly status: string = 'inactive'
  ) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice changed status.',
          attributes: {
            status: this.status
          }
        }
      ]
    });
  }
}

class SkillMergingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(private readonly targetUuid: string) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice expanded her operating range.',
          attributes: {
            skills: ['typescript', 'python'],
            tags: ['operator', 'founder']
          }
        }
      ]
    });
  }
}

class TeamMergingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(private readonly targetUuid: string) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice collaborates with the research team.',
          attributes: {
            teams: ['research', 'platform']
          }
        }
      ]
    });
  }
}

class NullAttributeHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  constructor(private readonly targetUuid: string) {}

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: this.targetUuid,
          summary: 'Alice is mentioned in archival context.',
          attributes: {
            role: null,
            skills: null
          }
        }
      ]
    });
  }
}

class EpisodicRoleHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(messages: Array<{ role: string; content: string }>): Promise<string> {
    const userMessage = messages.find((message) => message.role === 'user')?.content ?? '';

    let role: string | null = null;
    if (userMessage.includes('role:engineer')) {
      role = 'engineer';
    } else if (userMessage.includes('role:manager')) {
      role = 'manager';
    }

    return JSON.stringify({
      entities: [
        {
          name: 'Alice',
          summary: 'Alice evolves across episodes.',
          attributes: {
            role
          }
        }
      ]
    });
  }
}
