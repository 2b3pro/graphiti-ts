/**
 * Search utility functions — port of Python's graphiti_core/search/search_utils.py (partial).
 */

import type { GraphDriver } from '../contracts';
import type { EntityEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { mapEntityNode } from '../namespaces/nodes';
import { mapEntityEdge } from '../namespaces/edges';
import type { RecordLike } from '../utils/records';
import { ENTITY_EDGE_RETURN_FIELDS } from '../driver/cypher-fields';

/**
 * Get entity nodes mentioned in the given episodes via MENTIONS edges.
 * Port of Python's get_mentioned_nodes().
 */
export async function getMentionedNodes(
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

/**
 * Get entity edges relevant to a query by searching edges connected to the given nodes.
 * Port of Python's get_relevant_edges().
 */
export async function getRelevantEdges(
  driver: GraphDriver,
  nodeUuids: string[],
  limit = 100
): Promise<EntityEdge[]> {
  if (nodeUuids.length === 0) return [];

  const result = await driver.executeQuery<RecordLike>(
    `
      MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
      WHERE source.uuid IN $node_uuids OR target.uuid IN $node_uuids
      RETURN DISTINCT
        ${ENTITY_EDGE_RETURN_FIELDS}
      LIMIT toInteger($limit)
    `,
    { params: { node_uuids: nodeUuids, limit }, routing: 'r' }
  );

  return result.records.map((record) => mapEntityEdge(record));
}

/**
 * Get entity nodes relevant to a query by finding nodes connected via edges to seed nodes.
 * Port of Python's get_relevant_nodes().
 */
export async function getRelevantNodes(
  driver: GraphDriver,
  nodeUuids: string[],
  limit = 100
): Promise<EntityNode[]> {
  if (nodeUuids.length === 0) return [];

  const result = await driver.executeQuery<RecordLike>(
    `
      MATCH (n:Entity)-[:RELATES_TO]-(m:Entity)
      WHERE n.uuid IN $node_uuids
      RETURN DISTINCT
        m.uuid AS uuid,
        m.name AS name,
        m.group_id AS group_id,
        coalesce(m.labels, labels(m)) AS labels,
        m.created_at AS created_at,
        m.name_embedding AS name_embedding,
        m.summary AS summary,
        m.attributes AS attributes
      LIMIT toInteger($limit)
    `,
    { params: { node_uuids: nodeUuids, limit }, routing: 'r' }
  );

  return result.records.map((record) => mapEntityNode(record));
}

/**
 * Find existing edges that may conflict/contradict a new edge.
 * Port of Python's get_edge_invalidation_candidates().
 */
export async function getEdgeInvalidationCandidates(
  driver: GraphDriver,
  sourceNodeUuid: string,
  targetNodeUuid: string,
  excludeUuids: string[] = []
): Promise<EntityEdge[]> {
  const result = await driver.executeQuery<RecordLike>(
    `
      MATCH (source:Entity {uuid: $source_uuid})-[e:RELATES_TO]->(target:Entity {uuid: $target_uuid})
      WHERE e.expired_at IS NULL
        AND NOT e.uuid IN $exclude_uuids
      RETURN
        ${ENTITY_EDGE_RETURN_FIELDS}
    `,
    {
      params: {
        source_uuid: sourceNodeUuid,
        target_uuid: targetNodeUuid,
        exclude_uuids: excludeUuids
      },
      routing: 'r'
    }
  );

  return result.records.map((record) => mapEntityEdge(record));
}
