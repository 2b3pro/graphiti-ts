import { EdgeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { EmbedderClient, GraphDriver } from '../contracts';
import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EpistemicStatus, EpistemicTransition, BirthScore } from '../domain/epistemic';
import { getRecordValue, parseDateValue, type RecordLike } from '../utils/records';
import { serializeForCypher } from '../utils/serialization';
import type { EntityEdgeOperations } from '../driver/operations/entity-edge-operations';
import type { EpisodicEdgeOperations } from '../driver/operations/episodic-edge-operations';
import { FalkorDriver } from '../driver/falkordb-driver';
import { Neo4jDriver } from '../driver/neo4j-driver';
import { ENTITY_EDGE_RETURN_FIELDS } from '../driver/cypher-fields';

export class EntityEdgeNamespace {
  constructor(
    private readonly driver: GraphDriver,
    private readonly embedder?: EmbedderClient | null,
    private readonly ops?: EntityEdgeOperations
  ) {}

  async save(edge: EntityEdge): Promise<EntityEdge> {
    validateGroupId(edge.group_id);

    if (!edge.fact_embedding && this.embedder) {
      edge.fact_embedding = await this.embedder.create([edge.fact.replaceAll('\n', ' ')]);
    }

    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      await ops.save(this.driver, edge);
      return edge;
    }

    await this.driver.executeQuery(
      `
        MATCH (source:Entity {uuid: $source_uuid})
        MATCH (target:Entity {uuid: $target_uuid})
        MERGE (source)-[e:RELATES_TO {uuid: $edge.uuid}]->(target)
        SET e += $edge
        RETURN e.uuid AS uuid
      `,
      {
        params: {
          source_uuid: edge.source_node_uuid,
          target_uuid: edge.target_node_uuid,
          edge: serializeForCypher(edge)
        }
      }
    );

    return edge;
  }

  async getByUuid(uuid: string): Promise<EntityEdge> {
    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      return ops.getByUuid(this.driver, uuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO {uuid: $uuid}]->(target:Entity)
        RETURN
          ${ENTITY_EDGE_RETURN_FIELDS}
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new EdgeNotFoundError(uuid);
    }

    return mapEntityEdge(record);
  }

  async deleteByUuid(uuid: string): Promise<void> {
    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      await ops.deleteByUuid(this.driver, uuid);
      return;
    }

    const result = await this.driver.executeQuery<{ deleted_count: number }>(
      `
        MATCH ()-[e:RELATES_TO {uuid: $uuid}]->()
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { uuid } }
    );

    if ((result.records[0]?.deleted_count ?? 0) === 0) {
      throw new EdgeNotFoundError(uuid);
    }
  }

  async saveBulk(edges: EntityEdge[]): Promise<EntityEdge[]> {
    if (edges.length === 0) return [];

    for (const edge of edges) {
      validateGroupId(edge.group_id);
    }

    if (this.embedder) {
      for (const edge of edges) {
        if (!edge.fact_embedding) {
          edge.fact_embedding = await this.embedder.create([edge.fact.replaceAll('\n', ' ')]);
        }
      }
    }

    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      await ops.saveBulk(this.driver, edges);
      return edges;
    }

    for (const edge of edges) {
      await this.save(edge);
    }

    return edges;
  }

  async getByUuids(uuids: string[]): Promise<EntityEdge[]> {
    if (uuids.length === 0) return [];

    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      return ops.getByUuids(this.driver, uuids);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
        WHERE e.uuid IN $uuids
        RETURN
          ${ENTITY_EDGE_RETURN_FIELDS}
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async getByGroupIds(groupIds: string[]): Promise<EntityEdge[]> {
    if (groupIds.length === 0) return [];

    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      return ops.getByGroupIds(this.driver, groupIds);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
        WHERE e.group_id IN $group_ids
        RETURN
          ${ENTITY_EDGE_RETURN_FIELDS}
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async getBetweenNodes(
    sourceNodeUuid: string,
    targetNodeUuid: string
  ): Promise<EntityEdge[]> {
    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      return ops.getBetweenNodes(this.driver, sourceNodeUuid, targetNodeUuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity {uuid: $source_uuid})-[e:RELATES_TO]->(target:Entity {uuid: $target_uuid})
        WHERE e.expired_at IS NULL
        RETURN
          ${ENTITY_EDGE_RETURN_FIELDS}
      `,
      { params: { source_uuid: sourceNodeUuid, target_uuid: targetNodeUuid }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async getByNodeUuid(nodeUuid: string): Promise<EntityEdge[]> {
    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      return ops.getByNodeUuid(this.driver, nodeUuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
        WHERE source.uuid = $node_uuid OR target.uuid = $node_uuid
        RETURN
          ${ENTITY_EDGE_RETURN_FIELDS}
      `,
      { params: { node_uuid: nodeUuid }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async deleteByUuids(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      await ops.deleteByUuids(this.driver, uuids);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH ()-[e:RELATES_TO]->()
        WHERE e.uuid IN $uuids
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { uuids } }
    );
  }

  async deleteByGroupId(groupId: string): Promise<void> {
    validateGroupId(groupId);

    const ops = this.ops ?? resolveEntityEdgeOps(this.driver);
    if (ops) {
      await ops.deleteByGroupId(this.driver, groupId);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH ()-[e:RELATES_TO]->()
        WHERE e.group_id = $group_id
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }
}

export class EpisodicEdgeNamespace {
  constructor(
    private readonly driver: GraphDriver,
    private readonly ops?: EpisodicEdgeOperations
  ) {}

  async save(edge: EpisodicEdge): Promise<EpisodicEdge> {
    validateGroupId(edge.group_id);

    const ops = this.ops ?? resolveEpisodicEdgeOps(this.driver);
    if (ops) {
      await ops.save(this.driver, edge);
      return edge;
    }

    await this.driver.executeQuery(
      `
        MATCH (episode:Episodic {uuid: $source_uuid})
        MATCH (entity:Entity {uuid: $target_uuid})
        MERGE (episode)-[e:MENTIONS {uuid: $edge.uuid}]->(entity)
        SET e += $edge
        RETURN e.uuid AS uuid
      `,
      {
        params: {
          source_uuid: edge.source_node_uuid,
          target_uuid: edge.target_node_uuid,
          edge: serializeForCypher(edge)
        }
      }
    );

    return edge;
  }

  async saveBulk(edges: EpisodicEdge[]): Promise<EpisodicEdge[]> {
    if (edges.length === 0) return [];

    for (const edge of edges) {
      validateGroupId(edge.group_id);
    }

    const ops = this.ops ?? resolveEpisodicEdgeOps(this.driver);
    if (ops) {
      await ops.saveBulk(this.driver, edges);
      return edges;
    }

    for (const edge of edges) {
      await this.save(edge);
    }

    return edges;
  }

  async getByUuid(uuid: string): Promise<EpisodicEdge> {
    const ops = this.ops ?? resolveEpisodicEdgeOps(this.driver);
    if (ops) {
      return ops.getByUuid(this.driver, uuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (episode:Episodic)-[e:MENTIONS {uuid: $uuid}]->(entity:Entity)
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          episode.uuid AS source_node_uuid,
          entity.uuid AS target_node_uuid,
          e.created_at AS created_at
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new EdgeNotFoundError(uuid);
    }

    return mapEpisodicEdge(record);
  }

  async getByUuids(uuids: string[]): Promise<EpisodicEdge[]> {
    if (uuids.length === 0) return [];

    const ops = this.ops ?? resolveEpisodicEdgeOps(this.driver);
    if (ops) {
      return ops.getByUuids(this.driver, uuids);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (episode:Episodic)-[e:MENTIONS]->(entity:Entity)
        WHERE e.uuid IN $uuids
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          episode.uuid AS source_node_uuid,
          entity.uuid AS target_node_uuid,
          e.created_at AS created_at
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapEpisodicEdge(record));
  }

  async deleteByUuids(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    const ops = this.ops ?? resolveEpisodicEdgeOps(this.driver);
    if (ops) {
      await ops.deleteByUuids(this.driver, uuids);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH ()-[e:MENTIONS]->()
        WHERE e.uuid IN $uuids
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { uuids } }
    );
  }

  async deleteByGroupId(groupId: string): Promise<void> {
    validateGroupId(groupId);

    const ops = this.ops ?? resolveEpisodicEdgeOps(this.driver);
    if (ops) {
      await ops.deleteByGroupId(this.driver, groupId);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH ()-[e:MENTIONS]->()
        WHERE e.group_id = $group_id
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }
}

function mapEpisodicEdge(record: RecordLike): EpisodicEdge {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    source_node_uuid: getRecordValue<string>(record, 'source_node_uuid') ?? '',
    target_node_uuid: getRecordValue<string>(record, 'target_node_uuid') ?? '',
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date()
  };
}

export interface EdgeNamespaceApi {
  entity: EntityEdgeNamespace;
  episodic: EpisodicEdgeNamespace;
}

export function createEdgeNamespace(
  driver: GraphDriver,
  embedder?: EmbedderClient | null
): EdgeNamespaceApi {
  const ops = resolveEntityEdgeOps(driver);
  const episodicOps = resolveEpisodicEdgeOps(driver);

  return {
    entity: new EntityEdgeNamespace(driver, embedder, ops),
    episodic: new EpisodicEdgeNamespace(driver, episodicOps)
  };
}

export function mapEntityEdge(record: RecordLike): EntityEdge {
  const rawConfidence = getRecordValue<number[] | null>(record, 'confidence');
  const confidence: [number, number, number] | null =
    Array.isArray(rawConfidence) && rawConfidence.length === 3
      ? [rawConfidence[0] ?? 0, rawConfidence[1] ?? 0, rawConfidence[2] ?? 0]
      : null;

  // Epistemic fields — complex objects stored as JSON strings in Neo4j
  const rawEpistemicHistory = getRecordValue<string | EpistemicTransition[] | null>(record, 'epistemic_history');
  let epistemicHistory: EpistemicTransition[] | null = null;
  if (rawEpistemicHistory) {
    if (typeof rawEpistemicHistory === 'string') {
      try {
        const parsed = JSON.parse(rawEpistemicHistory) as EpistemicTransition[];
        epistemicHistory = parsed.map((t) => ({
          ...t,
          timestamp: new Date(t.timestamp),
        }));
      } catch {
        epistemicHistory = null;
      }
    } else if (Array.isArray(rawEpistemicHistory)) {
      epistemicHistory = rawEpistemicHistory.map((t) => ({
        ...t,
        timestamp: t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp),
      }));
    }
  }

  const rawBirthScore = getRecordValue<string | BirthScore | null>(record, 'birth_score');
  let birthScore: BirthScore | null = null;
  if (rawBirthScore) {
    if (typeof rawBirthScore === 'string') {
      try {
        birthScore = JSON.parse(rawBirthScore) as BirthScore;
      } catch {
        birthScore = null;
      }
    } else {
      birthScore = rawBirthScore as BirthScore;
    }
  }

  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    source_node_uuid: getRecordValue<string>(record, 'source_node_uuid') ?? '',
    target_node_uuid: getRecordValue<string>(record, 'target_node_uuid') ?? '',
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    name: getRecordValue<string>(record, 'name') ?? '',
    fact: getRecordValue<string>(record, 'fact') ?? '',
    fact_embedding: getRecordValue<number[] | null>(record, 'fact_embedding') ?? null,
    episodes: getRecordValue<string[]>(record, 'episodes') ?? [],
    expired_at: parseDateValue(getRecordValue(record, 'expired_at')),
    valid_at: parseDateValue(getRecordValue(record, 'valid_at')),
    invalid_at: parseDateValue(getRecordValue(record, 'invalid_at')),
    confidence,
    epistemic_status: getRecordValue<EpistemicStatus | null>(record, 'epistemic_status') ?? null,
    supported_by: getRecordValue<string[] | null>(record, 'supported_by') ?? null,
    supports: getRecordValue<string[] | null>(record, 'supports') ?? null,
    disputed_by: getRecordValue<string[] | null>(record, 'disputed_by') ?? null,
    epistemic_history: epistemicHistory,
    birth_score: birthScore,
  };
}

function resolveEntityEdgeOps(driver: GraphDriver): EntityEdgeOperations | undefined {
  if (driver instanceof Neo4jDriver) {
    return driver.entityEdgeOps;
  }

  if (driver instanceof FalkorDriver) {
    return driver.entityEdgeOps;
  }

  return undefined;
}

function resolveEpisodicEdgeOps(driver: GraphDriver): EpisodicEdgeOperations | undefined {
  if (driver instanceof Neo4jDriver) {
    return driver.episodicEdgeOps;
  }

  if (driver instanceof FalkorDriver) {
    return driver.episodicEdgeOps;
  }

  return undefined;
}
