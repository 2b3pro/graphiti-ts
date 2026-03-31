import { NodeNotFoundError, validateGroupId, validateNodeLabels } from '@graphiti/shared';

import type { EmbedderClient, GraphDriver } from '../../contracts';
import type { EntityNode } from '../../domain/nodes';
import { mapEntityNode } from '../../namespaces/nodes';
import { type RecordLike } from '../../utils/records';
import { serializeForFalkor } from '../../utils/serialization';
import type { EntityNodeOperations } from '../operations/entity-node-operations';

export class FalkorEntityNodeOperations implements EntityNodeOperations {
  async saveBulk(driver: GraphDriver, nodes: EntityNode[]): Promise<void> {
    if (nodes.length === 0) return;

    for (const node of nodes) {
      validateGroupId(node.group_id);
      validateNodeLabels(node.labels);
    }

    for (const node of nodes) {
      await driver.executeQuery(
        `
          MERGE (n:Entity {uuid: $entity.uuid})
          SET n += $entity
          SET n.labels = $labels
          RETURN n.uuid AS uuid
        `,
        {
          params: {
            entity: serializeForFalkor({ ...node, labels: undefined }),
            labels: ['Entity', ...node.labels]
          }
        }
      );
    }
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<EntityNode[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)
        WHERE n.uuid IN $uuids
        RETURN
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

  async getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<EntityNode[]> {
    if (groupIds.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)
        WHERE n.group_id IN $group_ids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityNode(record));
  }

  async save(driver: GraphDriver, node: EntityNode): Promise<void> {
    validateGroupId(node.group_id);
    validateNodeLabels(node.labels);

    await driver.executeQuery(
      `
        MERGE (n:Entity {uuid: $entity.uuid})
        SET n += $entity
        SET n.labels = $labels
        RETURN n.uuid AS uuid
      `,
      {
        params: {
          entity: serializeForFalkor({
            ...node,
            labels: undefined
          }),
          labels: ['Entity', ...node.labels]
        }
      }
    );
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<EntityNode> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity {uuid: $uuid})
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
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

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
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

  async deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void> {
    validateGroupId(groupId);

    await driver.executeQuery(
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

  async loadEmbeddings(
    driver: GraphDriver,
    node: EntityNode,
    embedder: EmbedderClient
  ): Promise<EntityNode> {
    if (!node.name_embedding) {
      node.name_embedding = await embedder.create([node.name.replaceAll('\n', ' ')]);
    }
    return node;
  }

  async loadEmbeddingsBulk(
    driver: GraphDriver,
    nodes: EntityNode[],
    embedder: EmbedderClient
  ): Promise<EntityNode[]> {
    for (const node of nodes) {
      if (!node.name_embedding) {
        node.name_embedding = await embedder.create([node.name.replaceAll('\n', ' ')]);
      }
    }
    return nodes;
  }
}
