import type { GraphDriver } from '../contracts';
import type { EntityAttributes } from '../domain/common';
import type { EntityEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { mapEntityEdge } from '../namespaces/edges';
import { mapEntityNode } from '../namespaces/nodes';
import { cosineSimilarity } from '../search/ranking';
import type { RecordLike } from '../utils/records';
import type { EpisodeExtractionResult } from './extractor';

export interface EpisodeResolutionResult {
  entities: EntityNode[];
  entity_edges: EntityEdge[];
  invalidated_edges: EntityEdge[];
}

interface ExistingRelationship {
  source_uuid: string;
  source_name: string;
  target_uuid: string;
  target_name: string;
  name: string;
}

export async function resolveEpisodeExtraction(
  driver: GraphDriver,
  episode: EpisodicNode,
  extraction: EpisodeExtractionResult
): Promise<EpisodeResolutionResult> {
  const resolvedEntities = await resolveEntities(
    driver,
    episode.group_id,
    extraction.entities,
    extraction.entity_edges
  );
  const resolvedEntityByUuid = new Map(
    extraction.entities.map((entity, index) => [entity.uuid, resolvedEntities[index] ?? entity])
  );
  const remappedEdges = extraction.entity_edges
    .map((edge) => {
      const resolvedSource = resolvedEntityByUuid.get(edge.source_node_uuid);
      const resolvedTarget = resolvedEntityByUuid.get(edge.target_node_uuid);

      if (!resolvedSource || !resolvedTarget) {
        return null;
      }

      return {
        ...edge,
        source_node_uuid: resolvedSource.uuid,
        target_node_uuid: resolvedTarget.uuid
      };
    })
    .filter((edge) => edge !== null);
  const resolvedEdges = await resolveEdges(driver, episode.group_id, remappedEdges, episode.uuid);

  return {
    entities: resolvedEntities,
    entity_edges: resolvedEdges.entity_edges,
    invalidated_edges: resolvedEdges.invalidated_edges
  };
}

async function resolveEntities(
  driver: GraphDriver,
  groupId: string,
  entities: EntityNode[],
  extractedEdges: EntityEdge[]
): Promise<EntityNode[]> {
  if (entities.length === 0) {
    return [];
  }

  const result = await driver.executeQuery<RecordLike>(
    `
      MATCH (n:Entity)
      WHERE n.group_id = $group_id
      RETURN
        n.uuid AS uuid,
        n.name AS name,
        n.group_id AS group_id,
        coalesce(n.labels, labels(n)) AS labels,
        n.created_at AS created_at,
        n.name_embedding AS name_embedding,
        n.summary AS summary,
        n.attributes AS attributes
      ORDER BY n.created_at DESC
      LIMIT 200
    `,
    {
      params: {
        group_id: groupId
      },
      routing: 'r'
    }
  );

  const existingEntities = result.records.map((record) => mapEntityNode(record));
  const relationships = extractedEdges.length
    ? await loadEntityRelationships(driver, groupId)
    : [];
  const candidateMap = new Map(
    entities.map((entity) => [entity.uuid, getEntityResolutionCandidates(entity, existingEntities)])
  );
  const resolvedByUuid = new Map<string, EntityNode>();

  for (const entity of entities) {
    const bestCandidate = candidateMap.get(entity.uuid)?.[0]?.candidate;
    resolvedByUuid.set(entity.uuid, bestCandidate ? mergeResolvedEntity(bestCandidate, entity) : entity);
  }

  if (relationships.length > 0) {
    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (const entity of entities) {
        const candidates = candidateMap.get(entity.uuid) ?? [];
        if (candidates.length === 0) {
          continue;
        }

        const bestCandidate = candidates.reduce((best, entry) => {
          const contextualScore =
            entry.score +
            scoreEntityRelationshipContext(
              entity.uuid,
              entry.candidate,
              entities,
              extractedEdges,
              resolvedByUuid,
              relationships
            );

          if (!best || contextualScore > best.score) {
            return {
              candidate: entry.candidate,
              score: contextualScore
            };
          }

          return best;
        }, null as { candidate: EntityNode; score: number } | null);

        if (bestCandidate) {
          resolvedByUuid.set(entity.uuid, mergeResolvedEntity(bestCandidate.candidate, entity));
        }
      }
    }
  }

  return entities.map((entity) => resolvedByUuid.get(entity.uuid) ?? entity);
}

async function resolveEdges(
  driver: GraphDriver,
  groupId: string,
  edges: EntityEdge[],
  episodeUuid: string
): Promise<{ entity_edges: EntityEdge[]; invalidated_edges: EntityEdge[] }> {
  if (edges.length === 0) {
    return {
      entity_edges: [],
      invalidated_edges: []
    };
  }

  const result = await driver.executeQuery<RecordLike>(
    `
      UNWIND $edge_keys AS edge_key
      MATCH (source:Entity)-[e:RELATES_TO]-(target:Entity)
      WHERE
        e.group_id = $group_id AND
        ((source.uuid = edge_key.source_node_uuid AND target.uuid = edge_key.target_node_uuid) OR
         (source.uuid = edge_key.target_node_uuid AND target.uuid = edge_key.source_node_uuid)) AND
        toLower(e.name) = edge_key.name_lower
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
        e.invalid_at AS invalid_at
    `,
    {
      params: {
        group_id: groupId,
        edge_keys: edges.map((edge) => ({
          source_node_uuid: edge.source_node_uuid,
          target_node_uuid: edge.target_node_uuid,
          name_lower: edge.name.toLowerCase()
        }))
      },
      routing: 'r'
    }
  );

  const existingByKey = new Map<string, EntityEdge[]>();

  for (const record of result.records) {
    const edge = mapEntityEdge(record);
    const key = edgeKey(edge);
    const existing = existingByKey.get(key) ?? [];
    existing.push(edge);
    existingByKey.set(key, existing);
  }

  const invalidatedEdges: EntityEdge[] = [];
  const resolvedEdges = edges.map((edge) => {
      const incomingTime = edge.valid_at ?? edge.created_at;
      const existing = (existingByKey.get(edgeKey(edge)) ?? []).sort(
        (left, right) => edgeEffectiveTime(right).getTime() - edgeEffectiveTime(left).getTime()
      );

      if (existing.length === 0) {
        return {
          ...edge,
          valid_at: edge.valid_at ?? incomingTime
        };
      }

      const activeExisting = existing.filter((existingEdge) =>
        isEdgeActiveAt(existingEdge, incomingTime)
      );
      const equivalentActive = activeExisting.find((existingEdge) =>
        isSemanticallyEquivalentFact(existingEdge, edge)
      );
      if (equivalentActive) {
        return {
          ...equivalentActive,
          fact: equivalentActive.fact || edge.fact,
          episodes: [...new Set([...(equivalentActive.episodes ?? []), episodeUuid])]
        };
      }

      const futureConflicts = activeExisting.filter(
        (existingEdge) =>
          !isSemanticallyEquivalentFact(existingEdge, edge) &&
          edgeEffectiveTime(existingEdge).getTime() > incomingTime.getTime()
      );
      if (futureConflicts[0]) {
        return {
          ...edge,
          episodes: [episodeUuid],
          valid_at: edge.valid_at ?? incomingTime,
          invalid_at: futureConflicts[0].valid_at ?? futureConflicts[0].created_at,
          expired_at: futureConflicts[0].valid_at ?? futureConflicts[0].created_at
        };
      }

      for (const existingEdge of activeExisting) {
        if (isSemanticallyEquivalentFact(existingEdge, edge)) {
          continue;
        }

        invalidatedEdges.push({
          ...existingEdge,
          invalid_at: incomingTime,
          expired_at: incomingTime,
          episodes: [...new Set([...(existingEdge.episodes ?? []), episodeUuid])]
        });
      }

      return {
        ...edge,
        episodes: [episodeUuid],
        valid_at: edge.valid_at ?? incomingTime
      };
    });

  return {
    entity_edges: dedupeResolvedEdges(resolvedEdges, (edge) => edgeKey(edge)),
    invalidated_edges: dedupeResolvedEdges(invalidatedEdges, (edge) => edge.uuid)
  };
}

function dedupeResolvedEdges(
  edges: EntityEdge[],
  keyGetter: (edge: EntityEdge) => string
): EntityEdge[] {
  const seen = new Set<string>();
  const resolved: EntityEdge[] = [];

  for (const edge of edges) {
    const key = keyGetter(edge);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    resolved.push(edge);
  }

  return resolved;
}

function edgeKey(edge: Pick<EntityEdge, 'source_node_uuid' | 'target_node_uuid' | 'name'>): string {
  return `${edge.source_node_uuid}:${edge.name.toLowerCase()}:${edge.target_node_uuid}`;
}

function normalizeFact(fact: string): string {
  return fact.trim().toLowerCase();
}

function resolveExistingEntity(
  entity: EntityNode,
  existingEntities: EntityNode[]
): EntityNode | undefined {
  return getEntityResolutionCandidates(entity, existingEntities)[0]?.candidate;
}

async function loadEntityRelationships(
  driver: GraphDriver,
  groupId: string
): Promise<ExistingRelationship[]> {
  const result = await driver.executeQuery<RecordLike>(
    `
      MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
      WHERE e.group_id = $group_id
      RETURN
        source.uuid AS source_uuid,
        source.name AS source_name,
        target.uuid AS target_uuid,
        target.name AS target_name,
        e.name AS name
      LIMIT 500
    `,
    {
      params: {
        group_id: groupId
      },
      routing: 'r'
    }
  );

  return result.records.map((record) => ({
    source_uuid: String(record.source_uuid ?? ''),
    source_name: String(record.source_name ?? ''),
    target_uuid: String(record.target_uuid ?? ''),
    target_name: String(record.target_name ?? ''),
    name: String(record.name ?? '')
  }));
}

function getEntityResolutionCandidates(
  entity: EntityNode,
  existingEntities: EntityNode[]
): Array<{ candidate: EntityNode; score: number }> {
  const lexicalCandidates = existingEntities
    .map((candidate) => ({
      candidate,
      score: scoreEntityLinkMatch(entity, candidate)
    }))
    .filter((entry) => entry.score >= 0.72)
    .sort((left, right) => right.score - left.score);

  if (lexicalCandidates.length > 0) {
    return lexicalCandidates.slice(0, 5);
  }

  return existingEntities
    .map((candidate) => ({
      candidate,
      score: cosineSimilarity(entity.name_embedding ?? [], candidate.name_embedding ?? [])
    }))
    .filter((entry) => entry.score >= 0.9)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function scoreEntityRelationshipContext(
  entityUuid: string,
  candidate: EntityNode,
  extractedEntities: EntityNode[],
  extractedEdges: EntityEdge[],
  resolvedByUuid: Map<string, EntityNode>,
  relationships: ExistingRelationship[]
): number {
  let score = 0;

  for (const edge of extractedEdges) {
    let otherUuid: string | null = null;
    let direction: 'out' | 'in' | null = null;

    if (edge.source_node_uuid === entityUuid) {
      otherUuid = edge.target_node_uuid;
      direction = 'out';
    } else if (edge.target_node_uuid === entityUuid) {
      otherUuid = edge.source_node_uuid;
      direction = 'in';
    }

    if (!otherUuid || !direction) {
      continue;
    }

    const otherResolved = resolvedByUuid.get(otherUuid);
    const otherExtracted = extractedEntities.find((entry) => entry.uuid === otherUuid);
    if (!otherResolved && !otherExtracted) {
      continue;
    }

    const matches = relationships.some((relationship) => {
      if (relationship.name.toLowerCase() !== edge.name.toLowerCase()) {
        return false;
      }

      if (direction === 'out') {
        return (
          relationship.source_uuid === candidate.uuid &&
          relationshipTargetMatches(relationship.target_uuid, otherResolved, otherExtracted)
        );
      }

      return (
        relationship.target_uuid === candidate.uuid &&
        relationshipTargetMatches(relationship.source_uuid, otherResolved, otherExtracted)
      );
    });

    if (matches) {
      score += 0.12;
    }
  }

  return score;
}

function relationshipTargetMatches(
  relationshipUuid: string,
  resolved: EntityNode | undefined,
  extracted: EntityNode | undefined
): boolean {
  if (resolved && relationshipUuid === resolved.uuid) {
    return true;
  }

  if (!extracted) {
    return false;
  }

  return resolved ? relationshipUuid === resolved.uuid : false;
}

function mergeResolvedEntity(existing: EntityNode, incoming: EntityNode): EntityNode {
  const mergedAttributes = mergeEntityAttributes(existing.attributes, incoming.attributes);

  return {
    ...existing,
    labels: [...new Set([...existing.labels, ...incoming.labels])],
    summary: existing.summary || incoming.summary,
    ...(mergedAttributes ? { attributes: mergedAttributes } : {})
  };
}

function mergeEntityAttributes(
  existing: EntityAttributes | undefined,
  incoming: EntityAttributes | undefined
): EntityAttributes | undefined {
  if (!existing && !incoming) {
    return undefined;
  }

  const merged: EntityAttributes = {
    ...(existing ?? {})
  };

  for (const [key, value] of Object.entries(incoming ?? {})) {
    const existingValue = merged[key];
    if (isStringArray(existingValue) && isStringArray(value)) {
      merged[key] = [...new Set([...existingValue, ...value])];
      continue;
    }

    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function scoreEntityLinkMatch(left: EntityNode, right: EntityNode): number {
  let bestScore = scoreEntityNameMatch(left.name, right.name);

  for (const alias of getEntityAliases(left.attributes)) {
    bestScore = Math.max(bestScore, scoreEntityNameMatch(alias, right.name) - 0.01);
  }

  for (const alias of getEntityAliases(right.attributes)) {
    bestScore = Math.max(bestScore, scoreEntityNameMatch(left.name, alias) - 0.01);
  }

  for (const leftAlias of getEntityAliases(left.attributes)) {
    for (const rightAlias of getEntityAliases(right.attributes)) {
      bestScore = Math.max(bestScore, scoreEntityNameMatch(leftAlias, rightAlias) - 0.02);
    }
  }

  return bestScore;
}

function isSemanticallyEquivalentFact(left: EntityEdge, right: EntityEdge): boolean {
  if (normalizeFact(left.fact) === normalizeFact(right.fact)) {
    return true;
  }

  return cosineSimilarity(left.fact_embedding ?? [], right.fact_embedding ?? []) >= 0.92;
}

function isEdgeActiveAt(edge: EntityEdge, timestamp: Date): boolean {
  const invalidAt = edge.invalid_at?.getTime() ?? Number.POSITIVE_INFINITY;
  const expiredAt = edge.expired_at?.getTime() ?? Number.POSITIVE_INFINITY;
  return invalidAt > timestamp.getTime() && expiredAt > timestamp.getTime();
}

function edgeEffectiveTime(edge: EntityEdge): Date {
  return edge.valid_at ?? edge.created_at;
}

function scoreEntityNameMatch(left: string, right: string): number {
  const normalizedLeft = normalizeEntityName(left);
  const normalizedRight = normalizeEntityName(right);
  if (normalizedLeft === '' || normalizedRight === '') {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftTokens = normalizedLeft.split(' ').map(normalizeEntityToken);
  const rightTokens = normalizedRight.split(' ').map(normalizeEntityToken);
  const aliasNormalizedLeft = leftTokens.join(' ');
  const aliasNormalizedRight = rightTokens.join(' ');

  if (aliasNormalizedLeft === aliasNormalizedRight) {
    return 0.96;
  }

  if (rightTokens.includes(normalizedLeft) || leftTokens.includes(normalizedRight)) {
    return 0.92;
  }

  if (
    aliasNormalizedRight.startsWith(`${aliasNormalizedLeft} `) ||
    aliasNormalizedLeft.startsWith(`${aliasNormalizedRight} `)
  ) {
    return 0.9;
  }

  const sharedTokenCount = leftTokens.filter((token) => rightTokens.includes(token)).length;
  const tokenUnionCount = new Set([...leftTokens, ...rightTokens]).size;
  const tokenSimilarity = tokenUnionCount === 0 ? 0 : sharedTokenCount / tokenUnionCount;

  return tokenSimilarity;
}

function normalizeEntityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEntityToken(value: string): string {
  return ENTITY_ALIASES.get(value) ?? value;
}

function getEntityAliases(attributes: EntityAttributes | undefined): string[] {
  if (!attributes) {
    return [];
  }

  const aliases = attributes.aliases;
  if (typeof aliases === 'string') {
    return [aliases];
  }

  if (Array.isArray(aliases) && aliases.every((value) => typeof value === 'string')) {
    return aliases;
  }

  return [];
}

const ENTITY_ALIASES = new Map<string, string>([
  ['bob', 'robert'],
  ['bobby', 'robert'],
  ['rob', 'robert'],
  ['robbie', 'robert'],
  ['alicia', 'alice'],
  ['ally', 'alice'],
  ['alex', 'alexander'],
  ['liz', 'elizabeth'],
  ['beth', 'elizabeth'],
  ['kate', 'katherine'],
  ['katie', 'katherine'],
  ['mike', 'michael'],
  ['mikey', 'michael'],
  ['dave', 'david'],
  ['davy', 'david'],
  ['sam', 'samuel'],
  ['sammie', 'samuel'],
  ['tom', 'thomas'],
  ['tommy', 'thomas'],
  ['bill', 'william'],
  ['billy', 'william'],
  ['will', 'william']
]);
