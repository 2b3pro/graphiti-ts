import {
  NodeNotFoundError,
  validateGroupId,
  validateNodeLabels
} from '@graphiti/shared';

import type { EmbedderClient, GraphDriver } from '../contracts';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { getRecordValue, parseDateValue, type RecordLike } from '../utils/records';
import { serializeForCypher } from '../utils/serialization';
import type { EntityNodeOperations } from '../driver/operations/entity-node-operations';
import type { EpisodeNodeOperations } from '../driver/operations/episode-node-operations';
import { FalkorDriver } from '../driver/falkordb-driver';
import { Neo4jDriver } from '../driver/neo4j-driver';

export class EntityNodeNamespace {
  constructor(
    private readonly driver: GraphDriver,
    private readonly embedder?: EmbedderClient | null,
    private readonly ops?: EntityNodeOperations
  ) {}

  async save(node: EntityNode): Promise<EntityNode> {
    validateGroupId(node.group_id);
    validateNodeLabels(node.labels);

    if (!node.name_embedding && this.embedder) {
      node.name_embedding = await this.embedder.create([node.name.replaceAll('\n', ' ')]);
    }

    const ops = this.ops ?? resolveEntityNodeOps(this.driver);
    if (ops) {
      await ops.save(this.driver, node);
      return node;
    }

    await this.driver.executeQuery(
      `
        MERGE (n:Entity {uuid: $entity.uuid})
        SET n += $entity
        SET n.labels = $labels
        RETURN n.uuid AS uuid
      `,
      {
        params: {
          entity: serializeForCypher({
            ...node,
            labels: undefined
          }),
          labels: node.labels
        }
      }
    );

    return node;
  }

  async getByUuid(uuid: string): Promise<EntityNode> {
    const ops = this.ops ?? resolveEntityNodeOps(this.driver);
    if (ops) {
      return ops.getByUuid(this.driver, uuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity {uuid: $uuid})
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          labels(n) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new NodeNotFoundError(uuid);
    }

    return mapEntityNode(record);
  }

  async saveBulk(nodes: EntityNode[]): Promise<EntityNode[]> {
    if (nodes.length === 0) return [];

    for (const node of nodes) {
      validateGroupId(node.group_id);
      validateNodeLabels(node.labels);
    }

    if (this.embedder) {
      for (const node of nodes) {
        if (!node.name_embedding) {
          node.name_embedding = await this.embedder.create([node.name.replaceAll('\n', ' ')]);
        }
      }
    }

    const ops = this.ops ?? resolveEntityNodeOps(this.driver);
    if (ops) {
      await ops.saveBulk(this.driver, nodes);
      return nodes;
    }

    for (const node of nodes) {
      await this.save(node);
    }

    return nodes;
  }

  async getByUuids(uuids: string[]): Promise<EntityNode[]> {
    if (uuids.length === 0) return [];

    const ops = this.ops ?? resolveEntityNodeOps(this.driver);
    if (ops) {
      return ops.getByUuids(this.driver, uuids);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)
        WHERE n.uuid IN $uuids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          labels(n) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityNode(record));
  }

  async getByGroupIds(groupIds: string[]): Promise<EntityNode[]> {
    if (groupIds.length === 0) return [];

    const ops = this.ops ?? resolveEntityNodeOps(this.driver);
    if (ops) {
      return ops.getByGroupIds(this.driver, groupIds);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)
        WHERE n.group_id IN $group_ids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          labels(n) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityNode(record));
  }

  async deleteByUuids(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    const ops = this.ops ?? resolveEntityNodeOps(this.driver);
    if (ops) {
      await ops.deleteByUuids(this.driver, uuids);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH (n:Entity)
        WHERE n.uuid IN $uuids
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { uuids } }
    );
  }

  async deleteByGroupId(groupId: string): Promise<void> {
    validateGroupId(groupId);

    const ops = this.ops ?? resolveEntityNodeOps(this.driver);
    if (ops) {
      await ops.deleteByGroupId(this.driver, groupId);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH (n:Entity)
        WHERE n.group_id = $group_id
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }
}

export class EpisodeNodeNamespace {
  constructor(
    private readonly driver: GraphDriver,
    private readonly ops?: EpisodeNodeOperations
  ) {}

  async save(node: EpisodicNode): Promise<EpisodicNode> {
    validateGroupId(node.group_id);

    const ops = this.ops ?? resolveEpisodeNodeOps(this.driver);
    if (ops) {
      await ops.save(this.driver, node);
      return node;
    }

    await this.driver.executeQuery(
      `
        MERGE (n:Episodic {uuid: $episode.uuid})
        SET n += $episode
        SET n:Episodic
        RETURN n.uuid AS uuid
      `,
      {
        params: {
          episode: serializeForCypher(node)
        }
      }
    );

    return node;
  }

  async getByUuid(uuid: string): Promise<EpisodicNode> {
    const ops = this.ops ?? resolveEpisodeNodeOps(this.driver);
    if (ops) {
      return ops.getByUuid(this.driver, uuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic {uuid: $uuid})
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          labels(n) AS labels,
          n.created_at AS created_at,
          n.source AS source,
          n.source_description AS source_description,
          n.content AS content,
          n.valid_at AS valid_at,
          n.entity_edges AS entity_edges
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new NodeNotFoundError(uuid);
    }

    return mapEpisodeNode(record);
  }

  async getByGroupIds(
    groupIds: string[],
    lastN = 10,
    referenceTime?: Date | null
  ): Promise<EpisodicNode[]> {
    if (groupIds.length === 0) {
      return [];
    }

    const params: Record<string, unknown> = {
      group_ids: groupIds,
      limit: Math.trunc(lastN)
    };
    const whereClauses = ['n.group_id IN $group_ids'];

    if (referenceTime) {
      params.reference_time = referenceTime;
      whereClauses.push('(n.created_at <= $reference_time OR n.valid_at <= $reference_time)');
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)
        WHERE ${whereClauses.join(' AND ')}
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.source AS source,
          n.source_description AS source_description,
          n.content AS content,
          n.valid_at AS valid_at,
          n.entity_edges AS entity_edges
        ORDER BY n.created_at DESC
        LIMIT toInteger($limit)
      `,
      { params, routing: 'r' }
    );

    return result.records.map((record) => mapEpisodeNode(record));
  }

  async deleteByUuid(uuid: string): Promise<void> {
    const ops = this.ops ?? resolveEpisodeNodeOps(this.driver);
    if (ops) {
      await ops.deleteByUuid(this.driver, uuid);
      return;
    }

    const result = await this.driver.executeQuery<{ deleted_count: number }>(
      `
        MATCH (n:Episodic {uuid: $uuid})
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { uuid } }
    );

    if ((result.records[0]?.deleted_count ?? 0) === 0) {
      throw new NodeNotFoundError(uuid);
    }
  }

  async saveBulk(nodes: EpisodicNode[]): Promise<EpisodicNode[]> {
    if (nodes.length === 0) return [];

    for (const node of nodes) {
      validateGroupId(node.group_id);
    }

    const ops = this.ops ?? resolveEpisodeNodeOps(this.driver);
    if (ops) {
      await ops.saveBulk(this.driver, nodes);
      return nodes;
    }

    for (const node of nodes) {
      await this.save(node);
    }

    return nodes;
  }

  async getByUuids(uuids: string[]): Promise<EpisodicNode[]> {
    if (uuids.length === 0) return [];

    const ops = this.ops ?? resolveEpisodeNodeOps(this.driver);
    if (ops) {
      return ops.getByUuids(this.driver, uuids);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)
        WHERE n.uuid IN $uuids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          labels(n) AS labels,
          n.created_at AS created_at,
          n.source AS source,
          n.source_description AS source_description,
          n.content AS content,
          n.valid_at AS valid_at,
          n.entity_edges AS entity_edges
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapEpisodeNode(record));
  }

  async deleteByUuids(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    const ops = this.ops ?? resolveEpisodeNodeOps(this.driver);
    if (ops) {
      await ops.deleteByUuids(this.driver, uuids);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH (n:Episodic)
        WHERE n.uuid IN $uuids
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { uuids } }
    );
  }

  async deleteByGroupId(groupId: string): Promise<void> {
    validateGroupId(groupId);

    const ops = this.ops ?? resolveEpisodeNodeOps(this.driver);
    if (ops) {
      await ops.deleteByGroupId(this.driver, groupId);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH (n:Episodic)
        WHERE n.group_id = $group_id
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }
}

export interface NodeNamespaceApi {
  entity: EntityNodeNamespace;
  episode: EpisodeNodeNamespace;
}

export function createNodeNamespace(
  driver: GraphDriver,
  embedder?: EmbedderClient | null
): NodeNamespaceApi {
  const ops = resolveEntityNodeOps(driver);
  const episodeOps = resolveEpisodeNodeOps(driver);

  return {
    entity: new EntityNodeNamespace(driver, embedder, ops),
    episode: new EpisodeNodeNamespace(driver, episodeOps)
  };
}

export function mapEntityNode(record: RecordLike): EntityNode {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    name: getRecordValue<string>(record, 'name') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    labels: (getRecordValue<string[]>(record, 'labels') ?? []).filter((label) => label !== 'Entity'),
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    summary: getRecordValue<string>(record, 'summary') ?? '',
    name_embedding: getRecordValue<number[] | null>(record, 'name_embedding') ?? null,
    attributes: parseAttributes(getRecordValue(record, 'attributes'))
  };
}

export function mapEpisodeNode(record: RecordLike): EpisodicNode {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    name: getRecordValue<string>(record, 'name') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    labels: (getRecordValue<string[]>(record, 'labels') ?? []).filter((label) => label !== 'Episodic'),
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    source: (getRecordValue<string>(record, 'source') ?? 'text') as EpisodicNode['source'],
    source_description: getRecordValue<string>(record, 'source_description') ?? '',
    content: getRecordValue<string>(record, 'content') ?? '',
    valid_at: parseDateValue(getRecordValue(record, 'valid_at')),
    entity_edges: getRecordValue<string[]>(record, 'entity_edges') ?? []
  };
}

function resolveEntityNodeOps(driver: GraphDriver): EntityNodeOperations | undefined {
  if (driver instanceof Neo4jDriver) {
    return driver.entityNodeOps;
  }

  if (driver instanceof FalkorDriver) {
    return driver.entityNodeOps;
  }

  return undefined;
}

function resolveEpisodeNodeOps(driver: GraphDriver): EpisodeNodeOperations | undefined {
  if (driver instanceof Neo4jDriver) {
    return driver.episodeNodeOps;
  }

  if (driver instanceof FalkorDriver) {
    return driver.episodeNodeOps;
  }

  return undefined;
}

function parseAttributes(raw: unknown): NonNullable<EntityNode['attributes']> {
  if (!raw) {
    return {} as NonNullable<EntityNode['attributes']>;
  }

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as NonNullable<EntityNode['attributes']>;
    } catch {
      return {} as NonNullable<EntityNode['attributes']>;
    }
  }

  return raw as NonNullable<EntityNode['attributes']>;
}
