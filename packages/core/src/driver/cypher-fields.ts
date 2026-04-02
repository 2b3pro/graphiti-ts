/**
 * Shared Cypher RETURN clause fragments for EntityEdge queries.
 *
 * Every query that reads entity edges uses these field lists.
 * When adding new fields to EntityEdge, add them here ONCE.
 */

/**
 * Core relationship fields for entity edge queries (all `e.` prefixed).
 * Does NOT include source/target node UUIDs — compose with node variables as needed.
 *
 * Use directly when the source/target node variable names differ from `source`/`target`,
 * e.g.: `n.uuid AS source_node_uuid, m.uuid AS target_node_uuid, ${ENTITY_EDGE_FIELDS}`
 */
export const ENTITY_EDGE_FIELDS = `
  e.created_at AS created_at,
  e.name AS name,
  e.fact AS fact,
  e.fact_embedding AS fact_embedding,
  e.episodes AS episodes,
  e.expired_at AS expired_at,
  e.valid_at AS valid_at,
  e.invalid_at AS invalid_at,
  e.confidence AS confidence,
  e.epistemic_status AS epistemic_status,
  e.supported_by AS supported_by,
  e.supports AS supports,
  e.disputed_by AS disputed_by,
  e.epistemic_history AS epistemic_history,
  e.birth_score AS birth_score,
  e.conditions AS conditions,
  e.anchored_by AS anchored_by,
  e.anchors AS anchors,
  e.interpretations AS interpretations`.trim();

/**
 * Standard RETURN fields for entity edge queries.
 * Use with: MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
 *
 * Includes source/target node UUIDs from `source` and `target` variables.
 */
export const ENTITY_EDGE_RETURN_FIELDS = `
  e.uuid AS uuid,
  e.group_id AS group_id,
  source.uuid AS source_node_uuid,
  target.uuid AS target_node_uuid,
  ${ENTITY_EDGE_FIELDS}`.trim();

