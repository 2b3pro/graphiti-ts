import { EdgeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { GraphDriver } from '../../contracts';
import type { EpisodicEdge } from '../../domain/edges';
import { getRecordValue, parseDateValue, type RecordLike } from '../../utils/records';
import { serializeForFalkor } from '../../utils/serialization';
import type { EpisodicEdgeOperations } from '../operations/episodic-edge-operations';

export class FalkorEpisodicEdgeOperations implements EpisodicEdgeOperations {
  async saveBulk(driver: GraphDriver, edges: EpisodicEdge[]): Promise<void> {
    if (edges.length === 0) return;

    for (const edge of edges) {
      validateGroupId(edge.group_id);
    }

    for (const edge of edges) {
      await this.save(driver, edge);
    }
  }

  async save(driver: GraphDriver, edge: EpisodicEdge): Promise<void> {
    validateGroupId(edge.group_id);

    await driver.executeQuery(
      `
        MATCH (episode:Episodic {uuid: $episode_uuid})
        MATCH (entity:Entity {uuid: $entity_uuid})
        MERGE (episode)-[e:MENTIONS {uuid: $edge.uuid}]->(entity)
        SET e += $edge
        RETURN e.uuid AS uuid
      `,
      {
        params: {
          episode_uuid: edge.source_node_uuid,
          entity_uuid: edge.target_node_uuid,
          edge: serializeForFalkor(edge)
        }
      }
    );
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<EpisodicEdge> {
    const result = await driver.executeQuery<RecordLike>(
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

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<EpisodicEdge[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
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

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
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

  async deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void> {
    validateGroupId(groupId);

    await driver.executeQuery(
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
