import type { GraphDriver } from '../../contracts';
import type { CommunityNode, EntityNode, EpisodicNode } from '../../domain/nodes';
import { mapEntityNode } from '../../namespaces/nodes';
import { getRecordValue, parseDateValue, type RecordLike } from '../../utils/records';
import type { GraphMaintenanceOperations } from '../operations/graph-maintenance-operations';

export class Neo4jGraphMaintenanceOperations implements GraphMaintenanceOperations {
  async clearData(driver: GraphDriver, groupIds?: string[] | null): Promise<void> {
    if (!groupIds || groupIds.length === 0) {
      await driver.executeQuery('MATCH (n) DETACH DELETE n');
      return;
    }

    for (const label of ['Entity', 'Episodic', 'Community', 'Saga']) {
      await driver.executeQuery(
        `
          MATCH (n:${label})
          WHERE n.group_id IN $group_ids
          DETACH DELETE n
        `,
        { params: { group_ids: groupIds } }
      );
    }
  }

  async removeCommunities(driver: GraphDriver): Promise<void> {
    await driver.executeQuery('MATCH (c:Community) DETACH DELETE c');
  }

  async getMentionedNodes(
    driver: GraphDriver,
    episodes: EpisodicNode[]
  ): Promise<EntityNode[]> {
    if (episodes.length === 0) return [];

    const uuids = episodes.map((ep) => ep.uuid);

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (episode:Episodic)-[:MENTIONS]->(n:Entity)
        WHERE episode.uuid IN $uuids
        RETURN DISTINCT
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityNode(record));
  }

  async getCommunitiesByNodes(
    driver: GraphDriver,
    nodes: EntityNode[]
  ): Promise<CommunityNode[]> {
    if (nodes.length === 0) return [];

    const uuids = nodes.map((n) => n.uuid);

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (c:Community)-[:HAS_MEMBER]->(m:Entity)
        WHERE m.uuid IN $uuids
        RETURN DISTINCT
          c.uuid AS uuid,
          c.name AS name,
          c.group_id AS group_id,
          coalesce(c.labels, labels(c)) AS labels,
          c.created_at AS created_at,
          c.summary AS summary,
          c.name_embedding AS name_embedding
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapCommunityNode(record));
  }
}

function mapCommunityNode(record: RecordLike): CommunityNode {
  const rawLabels = getRecordValue<string[]>(record, 'labels') ?? [];

  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    name: getRecordValue<string>(record, 'name') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    labels: rawLabels.filter((label) => label !== 'Community'),
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    summary: getRecordValue<string>(record, 'summary') ?? '',
    name_embedding: getRecordValue<number[] | null>(record, 'name_embedding') ?? null
  };
}
