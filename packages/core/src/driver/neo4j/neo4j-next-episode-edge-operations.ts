import { EdgeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { GraphDriver } from '../../contracts';
import type { NextEpisodeEdge } from '../../domain/edges';
import { getRecordValue, parseDateValue, type RecordLike } from '../../utils/records';
import { serializeForCypher } from '../../utils/serialization';
import type { NextEpisodeEdgeOperations } from '../operations/next-episode-edge-operations';

export class Neo4jNextEpisodeEdgeOperations implements NextEpisodeEdgeOperations {
  async save(driver: GraphDriver, edge: NextEpisodeEdge): Promise<void> {
    validateGroupId(edge.group_id);

    await driver.executeQuery(
      `
        MATCH (source:Episodic {uuid: $source_uuid})
        MATCH (target:Episodic {uuid: $target_uuid})
        MERGE (source)-[e:NEXT_EPISODE {uuid: $edge.uuid}]->(target)
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
  }

  async saveBulk(driver: GraphDriver, edges: NextEpisodeEdge[]): Promise<void> {
    if (edges.length === 0) return;
    for (const edge of edges) {
      await this.save(driver, edge);
    }
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<NextEpisodeEdge> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)-[e:NEXT_EPISODE {uuid: $uuid}]->(m:Episodic)
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

    return mapNextEpisodeEdge(record);
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<NextEpisodeEdge[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)-[e:NEXT_EPISODE]->(m:Episodic)
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

    return result.records.map((record) => mapNextEpisodeEdge(record));
  }

  async getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<NextEpisodeEdge[]> {
    if (groupIds.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)-[e:NEXT_EPISODE]->(m:Episodic)
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

    return result.records.map((record) => mapNextEpisodeEdge(record));
  }

  async deleteByUuid(driver: GraphDriver, uuid: string): Promise<void> {
    const result = await driver.executeQuery<{ deleted_count: number }>(
      `
        MATCH (n:Episodic)-[e:NEXT_EPISODE {uuid: $uuid}]->(m:Episodic)
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
        MATCH (n:Episodic)-[e:NEXT_EPISODE]->(m:Episodic)
        WHERE e.uuid IN $uuids
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { uuids } }
    );
  }
}

function mapNextEpisodeEdge(record: RecordLike): NextEpisodeEdge {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    source_node_uuid: getRecordValue<string>(record, 'source_node_uuid') ?? '',
    target_node_uuid: getRecordValue<string>(record, 'target_node_uuid') ?? '',
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date()
  };
}
