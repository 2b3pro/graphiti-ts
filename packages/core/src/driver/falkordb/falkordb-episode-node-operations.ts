import { NodeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { GraphDriver } from '../../contracts';
import type { EpisodeType, EpisodicNode } from '../../domain/nodes';
import { mapEpisodeNode } from '../../namespaces/nodes';
import { type RecordLike } from '../../utils/records';
import { serializeForFalkor } from '../../utils/serialization';
import type { EpisodeNodeOperations } from '../operations/episode-node-operations';

export class FalkorEpisodeNodeOperations implements EpisodeNodeOperations {
  async saveBulk(driver: GraphDriver, nodes: EpisodicNode[]): Promise<void> {
    if (nodes.length === 0) return;

    for (const node of nodes) {
      validateGroupId(node.group_id);
    }

    for (const node of nodes) {
      await driver.executeQuery(
        `
          MERGE (n:Episodic {uuid: $episode.uuid})
          SET n += $episode
          SET n:Episodic
          RETURN n.uuid AS uuid
        `,
        { params: { episode: serializeForFalkor(node) } }
      );
    }
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<EpisodicNode[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)
        WHERE n.uuid IN $uuids
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
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapEpisodeNode(record));
  }

  async save(driver: GraphDriver, node: EpisodicNode): Promise<void> {
    validateGroupId(node.group_id);

    await driver.executeQuery(
      `
        MERGE (n:Episodic {uuid: $episode.uuid})
        SET n += $episode
        SET n:Episodic
        RETURN n.uuid AS uuid
      `,
      {
        params: {
          episode: serializeForFalkor(node)
        }
      }
    );
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<EpisodicNode> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic {uuid: $uuid})
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
    driver: GraphDriver,
    groupIds: string[],
    lastN?: number,
    referenceTime?: Date | null
  ): Promise<EpisodicNode[]> {
    if (groupIds.length === 0) return [];

    const refTime = referenceTime ?? new Date();
    const limit = lastN ?? 10;

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)
        WHERE n.group_id IN $group_ids
          AND n.valid_at <= $reference_time
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
        ORDER BY n.valid_at DESC
        LIMIT toInteger($limit)
      `,
      {
        params: {
          group_ids: groupIds,
          reference_time: refTime.toISOString(),
          limit
        },
        routing: 'r'
      }
    );

    return result.records.map((record) => mapEpisodeNode(record));
  }

  async getByEntityNodeUuid(
    driver: GraphDriver,
    entityNodeUuid: string
  ): Promise<EpisodicNode[]> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (e:Episodic)-[:MENTIONS]->(n:Entity {uuid: $entity_uuid})
        RETURN
          e.uuid AS uuid,
          e.name AS name,
          e.group_id AS group_id,
          coalesce(e.labels, labels(e)) AS labels,
          e.created_at AS created_at,
          e.source AS source,
          e.source_description AS source_description,
          e.content AS content,
          e.valid_at AS valid_at,
          e.entity_edges AS entity_edges
      `,
      { params: { entity_uuid: entityNodeUuid }, routing: 'r' }
    );

    return result.records.map((record) => mapEpisodeNode(record));
  }

  async retrieveEpisodes(
    driver: GraphDriver,
    referenceTime: Date,
    lastN = 3,
    groupIds?: string[] | null,
    source?: EpisodeType | null
  ): Promise<EpisodicNode[]> {
    const whereConditions = ['n.valid_at <= $reference_time'];
    const params: Record<string, unknown> = {
      reference_time: referenceTime.toISOString(),
      limit: lastN
    };

    if (groupIds && groupIds.length > 0) {
      whereConditions.push('n.group_id IN $group_ids');
      params.group_ids = groupIds;
    }

    if (source) {
      whereConditions.push('n.source = $source');
      params.source = source;
    }

    const whereClause = whereConditions.join(' AND ');

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)
        WHERE ${whereClause}
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
        ORDER BY n.valid_at DESC
        LIMIT toInteger($limit)
      `,
      { params, routing: 'r' }
    );

    return result.records.map((record) => mapEpisodeNode(record));
  }

  async deleteByUuid(driver: GraphDriver, uuid: string): Promise<void> {
    const result = await driver.executeQuery<{ deleted_count: number }>(
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

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
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

  async deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void> {
    validateGroupId(groupId);

    await driver.executeQuery(
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
