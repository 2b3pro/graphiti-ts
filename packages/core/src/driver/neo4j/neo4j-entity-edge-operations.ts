import { EdgeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { EmbedderClient, GraphDriver } from '../../contracts';
import type { EntityEdge } from '../../domain/edges';
import { mapEntityEdge } from '../../namespaces/edges';
import { type RecordLike } from '../../utils/records';
import { serializeForCypher } from '../../utils/serialization';
import type { EntityEdgeOperations } from '../operations/entity-edge-operations';

export class Neo4jEntityEdgeOperations implements EntityEdgeOperations {
  async saveBulk(driver: GraphDriver, edges: EntityEdge[]): Promise<void> {
    if (edges.length === 0) return;

    for (const edge of edges) {
      validateGroupId(edge.group_id);
    }

    for (const edge of edges) {
      await driver.executeQuery(
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
    }
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<EntityEdge[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
        WHERE e.uuid IN $uuids
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          source.uuid AS source_node_uuid,
          target.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async save(driver: GraphDriver, edge: EntityEdge): Promise<void> {
    validateGroupId(edge.group_id);

    await driver.executeQuery(
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
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<EntityEdge> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO {uuid: $uuid}]->(target:Entity)
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          source.uuid AS source_node_uuid,
          target.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new EdgeNotFoundError(uuid);
    }

    return mapEntityEdge(record);
  }

  async getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<EntityEdge[]> {
    if (groupIds.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
        WHERE e.group_id IN $group_ids
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          source.uuid AS source_node_uuid,
          target.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async getBetweenNodes(
    driver: GraphDriver,
    sourceNodeUuid: string,
    targetNodeUuid: string
  ): Promise<EntityEdge[]> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity {uuid: $source_uuid})-[e:RELATES_TO]->(target:Entity {uuid: $target_uuid})
        WHERE e.expired_at IS NULL
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          source.uuid AS source_node_uuid,
          target.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence
      `,
      { params: { source_uuid: sourceNodeUuid, target_uuid: targetNodeUuid }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async getByNodeUuid(driver: GraphDriver, nodeUuid: string): Promise<EntityEdge[]> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
        WHERE source.uuid = $node_uuid OR target.uuid = $node_uuid
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          source.uuid AS source_node_uuid,
          target.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence
      `,
      { params: { node_uuid: nodeUuid }, routing: 'r' }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async deleteByUuid(driver: GraphDriver, uuid: string): Promise<void> {
    const result = await driver.executeQuery<{ deleted_count: number }>(
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

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
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

  async deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void> {
    validateGroupId(groupId);

    await driver.executeQuery(
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

  async loadEmbeddings(
    driver: GraphDriver,
    edge: EntityEdge,
    embedder: EmbedderClient
  ): Promise<EntityEdge> {
    if (!edge.fact_embedding) {
      edge.fact_embedding = await embedder.create([edge.fact.replaceAll('\n', ' ')]);
    }
    return edge;
  }

  async loadEmbeddingsBulk(
    driver: GraphDriver,
    edges: EntityEdge[],
    embedder: EmbedderClient
  ): Promise<EntityEdge[]> {
    for (const edge of edges) {
      if (!edge.fact_embedding) {
        edge.fact_embedding = await embedder.create([edge.fact.replaceAll('\n', ' ')]);
      }
    }
    return edges;
  }
}
