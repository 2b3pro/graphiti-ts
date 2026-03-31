import { NodeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { EmbedderClient, GraphDriver } from '../../contracts';
import type { CommunityNode } from '../../domain/nodes';
import { getRecordValue, parseDateValue, type RecordLike } from '../../utils/records';
import { serializeForFalkor } from '../../utils/serialization';
import type { CommunityNodeOperations } from '../operations/community-node-operations';

function mapRecord(record: RecordLike): CommunityNode {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    name: getRecordValue<string>(record, 'name') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    labels: (getRecordValue<string[]>(record, 'labels') ?? []).filter((l) => l !== 'Community'),
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    summary: getRecordValue<string>(record, 'summary') ?? '',
    name_embedding: getRecordValue<number[] | null>(record, 'name_embedding') ?? null,
    rank: getRecordValue<number | null>(record, 'rank') ?? null
  };
}

export class FalkorCommunityNodeOperations implements CommunityNodeOperations {
  async save(driver: GraphDriver, node: CommunityNode): Promise<void> {
    validateGroupId(node.group_id);

    await driver.executeQuery(
      `
        MERGE (n:Community {uuid: $node.uuid})
        SET n += $node
        SET n.labels = $labels
        RETURN n.uuid AS uuid
      `,
      {
        params: {
          node: serializeForFalkor({
            ...node,
            labels: undefined
          }),
          labels: node.labels
        }
      }
    );
  }

  async saveBulk(driver: GraphDriver, nodes: CommunityNode[]): Promise<void> {
    if (nodes.length === 0) return;

    for (const node of nodes) {
      validateGroupId(node.group_id);
    }

    for (const node of nodes) {
      await this.save(driver, node);
    }
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<CommunityNode> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community {uuid: $uuid})
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.summary AS summary,
          n.name_embedding AS name_embedding,
          n.rank AS rank
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new NodeNotFoundError(uuid);
    }

    return mapRecord(record);
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<CommunityNode[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)
        WHERE n.uuid IN $uuids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.summary AS summary,
          n.name_embedding AS name_embedding,
          n.rank AS rank
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapRecord(record));
  }

  async getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<CommunityNode[]> {
    if (groupIds.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)
        WHERE n.group_id IN $group_ids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.summary AS summary,
          n.name_embedding AS name_embedding,
          n.rank AS rank
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapRecord(record));
  }

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
      `
        MATCH (n:Community)
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
        MATCH (n:Community)
        WHERE n.group_id = $group_id
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }

  async loadNameEmbedding(
    driver: GraphDriver,
    node: CommunityNode,
    embedder: EmbedderClient
  ): Promise<CommunityNode> {
    if (!node.name_embedding) {
      node.name_embedding = await embedder.create([node.name.replaceAll('\n', ' ')]);
    }
    return node;
  }
}
