import { EdgeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { GraphDriver } from '../../contracts';
import type { HasEpisodeEdge } from '../../domain/edges';
import { getRecordValue, parseDateValue, type RecordLike } from '../../utils/records';
import { serializeForFalkor } from '../../utils/serialization';
import type { HasEpisodeEdgeOperations } from '../operations/has-episode-edge-operations';

export class FalkorHasEpisodeEdgeOperations implements HasEpisodeEdgeOperations {
  async save(driver: GraphDriver, edge: HasEpisodeEdge): Promise<void> {
    validateGroupId(edge.group_id);

    await driver.executeQuery(
      `
        MATCH (saga:Saga {uuid: $saga_uuid})
        MATCH (episode:Episodic {uuid: $episode_uuid})
        MERGE (saga)-[e:HAS_EPISODE {uuid: $edge.uuid}]->(episode)
        SET e += $edge
        RETURN e.uuid AS uuid
      `,
      {
        params: {
          saga_uuid: edge.source_node_uuid,
          episode_uuid: edge.target_node_uuid,
          edge: serializeForFalkor(edge)
        }
      }
    );
  }

  async saveBulk(driver: GraphDriver, edges: HasEpisodeEdge[]): Promise<void> {
    if (edges.length === 0) return;
    for (const edge of edges) {
      await this.save(driver, edge);
    }
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<HasEpisodeEdge> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Saga)-[e:HAS_EPISODE {uuid: $uuid}]->(m:Episodic)
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new EdgeNotFoundError(uuid);
    }

    return mapHasEpisodeEdge(record);
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<HasEpisodeEdge[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Saga)-[e:HAS_EPISODE]->(m:Episodic)
        WHERE e.uuid IN $uuids
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapHasEpisodeEdge(record));
  }

  async getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<HasEpisodeEdge[]> {
    if (groupIds.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Saga)-[e:HAS_EPISODE]->(m:Episodic)
        WHERE e.group_id IN $group_ids
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at
        ORDER BY e.uuid DESC
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapHasEpisodeEdge(record));
  }

  async deleteByUuid(driver: GraphDriver, uuid: string): Promise<void> {
    const result = await driver.executeQuery<{ deleted_count: number }>(
      `
        MATCH (n:Saga)-[e:HAS_EPISODE {uuid: $uuid}]->(m:Episodic)
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

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
      `
        MATCH (n:Saga)-[e:HAS_EPISODE]->(m:Episodic)
        WHERE e.uuid IN $uuids
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { uuids } }
    );
  }
}

function mapHasEpisodeEdge(record: RecordLike): HasEpisodeEdge {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    source_node_uuid: getRecordValue<string>(record, 'source_node_uuid') ?? '',
    target_node_uuid: getRecordValue<string>(record, 'target_node_uuid') ?? '',
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date()
  };
}
