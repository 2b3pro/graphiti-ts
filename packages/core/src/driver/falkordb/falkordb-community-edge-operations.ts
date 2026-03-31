import { EdgeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { GraphDriver } from '../../contracts';
import type { CommunityEdge } from '../../domain/edges';
import { getRecordValue, parseDateValue, type RecordLike } from '../../utils/records';
import { serializeForFalkor } from '../../utils/serialization';
import type { CommunityEdgeOperations } from '../operations/community-edge-operations';

function mapRecord(record: RecordLike): CommunityEdge {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    source_node_uuid: getRecordValue<string>(record, 'source_node_uuid') ?? '',
    target_node_uuid: getRecordValue<string>(record, 'target_node_uuid') ?? '',
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    rank: getRecordValue<number | null>(record, 'rank') ?? null
  };
}

export class FalkorCommunityEdgeOperations implements CommunityEdgeOperations {
  async save(driver: GraphDriver, edge: CommunityEdge): Promise<void> {
    validateGroupId(edge.group_id);

    await driver.executeQuery(
      `
        MATCH (community:Community {uuid: $community_uuid})
        MATCH (member {uuid: $member_uuid})
        MERGE (community)-[e:HAS_MEMBER {uuid: $edge.uuid}]->(member)
        SET e += $edge
        RETURN e.uuid AS uuid
      `,
      {
        params: {
          community_uuid: edge.source_node_uuid,
          member_uuid: edge.target_node_uuid,
          edge: serializeForFalkor(edge)
        }
      }
    );
  }

  async saveBulk(driver: GraphDriver, edges: CommunityEdge[]): Promise<void> {
    if (edges.length === 0) return;

    for (const edge of edges) {
      validateGroupId(edge.group_id);
    }

    for (const edge of edges) {
      await this.save(driver, edge);
    }
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<CommunityEdge> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)-[e:HAS_MEMBER {uuid: $uuid}]->(m)
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.rank AS rank
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new EdgeNotFoundError(uuid);
    }

    return mapRecord(record);
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<CommunityEdge[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)-[e:HAS_MEMBER]->(m)
        WHERE e.uuid IN $uuids
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.rank AS rank
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapRecord(record));
  }

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
      `
        MATCH ()-[e:HAS_MEMBER]->()
        WHERE e.uuid IN $uuids
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { uuids } }
    );
  }
}
