import { randomUUID } from 'node:crypto';

import { utcNow } from '@graphiti/shared';

import type { EmbedderClient, GraphDriver, LLMClient } from '../contracts';
import type { CommunityEdge } from '../domain/edges';
import type { CommunityNode, EntityNode } from '../domain/nodes';
import type { RecordLike } from '../utils/records';
import { getRecordValue } from '../utils/records';
import { mapCommunityNode } from '../namespaces/communities';
import {
  summarizePairPrompt,
  summaryDescriptionPrompt,
  batchSummarizePrompt,
  batchNamePrompt,
} from './prompts';

export const MAX_COMMUNITY_BUILD_CONCURRENCY = 2;

/**
 * Max member summaries to include per community in a batched LLM call.
 * Communities larger than this get their summaries truncated to the first N members.
 */
const MAX_MEMBERS_PER_SUMMARY = 30;

/**
 * Max communities to batch in a single LLM call for summarization or naming.
 * Controls prompt size — each community adds ~100-200 tokens.
 */
const MAX_BATCH_SIZE = 40;

export interface Neighbor {
  node_uuid: string;
  edge_count: number;
}

// ---------------------------------------------------------------------------
// Label Propagation
// ---------------------------------------------------------------------------

export function labelPropagation(
  projection: Map<string, Neighbor[]>
): string[][] {
  const communityMap = new Map<string, number>();
  let idx = 0;
  for (const uuid of projection.keys()) {
    communityMap.set(uuid, idx++);
  }

  const maxIterations = projection.size * 10 + 10;
  let iteration = 0;

  while (iteration++ < maxIterations) {
    let noChange = true;
    const newCommunityMap = new Map<string, number>();

    for (const [uuid, neighbors] of projection) {
      const currCommunity = communityMap.get(uuid)!;

      const communityCandidates = new Map<number, number>();
      for (const neighbor of neighbors) {
        const neighborCommunity = communityMap.get(neighbor.node_uuid);
        if (neighborCommunity !== undefined) {
          communityCandidates.set(
            neighborCommunity,
            (communityCandidates.get(neighborCommunity) ?? 0) + neighbor.edge_count
          );
        }
      }

      const sorted = [...communityCandidates.entries()]
        .map(([community, count]) => ({ count, community }))
        .sort((a, b) => b.count - a.count || b.community - a.community);

      const first = sorted[0];
      const candidateRank = first !== undefined ? first.count : 0;
      const communityCandidate = first !== undefined ? first.community : -1;

      let newCommunity: number;
      if (communityCandidate !== -1 && candidateRank > 1) {
        // Prefer higher community ID to break oscillation in small graphs
        newCommunity = Math.max(communityCandidate, currCommunity);
      } else {
        newCommunity = Math.max(communityCandidate, currCommunity);
      }

      newCommunityMap.set(uuid, newCommunity);

      if (newCommunity !== currCommunity) {
        noChange = false;
      }
    }

    // FIX: Update community_map BEFORE break check so the last iteration's
    // result is preserved when the loop exits at maxIterations.
    for (const [uuid, community] of newCommunityMap) {
      communityMap.set(uuid, community);
    }

    if (noChange) {
      break;
    }
  }

  const clusterMap = new Map<number, string[]>();
  for (const [uuid, community] of communityMap) {
    const cluster = clusterMap.get(community);
    if (cluster) {
      cluster.push(uuid);
    } else {
      clusterMap.set(community, [uuid]);
    }
  }

  return [...clusterMap.values()];
}

// ---------------------------------------------------------------------------
// Community Clustering
// ---------------------------------------------------------------------------

export interface EntityNodeNamespaceReader {
  getByGroupIds(groupIds: string[]): Promise<EntityNode[]>;
  getByUuids(uuids: string[]): Promise<EntityNode[]>;
}

export async function getCommunityClusters(
  driver: GraphDriver,
  entityNodes: EntityNodeNamespaceReader,
  groupIds: string[] | null
): Promise<EntityNode[][]> {
  const communityClusters: EntityNode[][] = [];

  let resolvedGroupIds = groupIds;
  if (resolvedGroupIds === null) {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)
        WHERE n.group_id IS NOT NULL
        RETURN collect(DISTINCT n.group_id) AS group_ids
      `,
      { routing: 'r' }
    );
    const firstRecord = result.records[0];
    resolvedGroupIds =
      firstRecord !== undefined
        ? (getRecordValue<string[]>(firstRecord, 'group_ids') ?? [])
        : [];
  }

  for (const groupId of resolvedGroupIds) {
    const projection = new Map<string, Neighbor[]>();
    const nodes = await entityNodes.getByGroupIds([groupId]);

    for (const node of nodes) {
      const neighborResult = await driver.executeQuery<RecordLike>(
        `
          MATCH (n:Entity {group_id: $group_id, uuid: $uuid})-[e:RELATES_TO]-(m:Entity {group_id: $group_id})
          WITH count(e) AS count, m.uuid AS uuid
          RETURN uuid, count
        `,
        { params: { uuid: node.uuid, group_id: groupId }, routing: 'r' }
      );

      projection.set(
        node.uuid,
        neighborResult.records.map((record) => ({
          node_uuid: getRecordValue<string>(record, 'uuid') ?? '',
          edge_count: Number(getRecordValue<number>(record, 'count') ?? 0)
        }))
      );
    }

    const clusterUuids = labelPropagation(projection);

    const clusters = await Promise.all(
      clusterUuids.map((uuids) => entityNodes.getByUuids(uuids))
    );
    communityClusters.push(...clusters);
  }

  return communityClusters;
}

// ---------------------------------------------------------------------------
// GDS Leiden Community Detection (preferred over label propagation)
// ---------------------------------------------------------------------------

/**
 * Check if Neo4j GDS plugin is available.
 */
async function hasGDS(driver: GraphDriver): Promise<boolean> {
  try {
    const result = await driver.executeQuery<RecordLike>(
      `RETURN gds.version() AS version`,
      { routing: 'r' }
    );
    return result.records.length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect communities using Neo4j GDS Leiden algorithm.
 * Returns clusters as arrays of entity UUIDs. Filters out singleton communities.
 *
 * Requires: Neo4j GDS plugin installed, RELATES_TO edges in graph.
 */
export async function getCommunityClustersGDS(
  driver: GraphDriver,
  entityNodes: EntityNodeNamespaceReader,
  groupIds: string[] | null
): Promise<EntityNode[][]> {
  const graphName = `community-detection-${Date.now()}`;

  let resolvedGroupIds = groupIds;
  if (resolvedGroupIds === null) {
    const result = await driver.executeQuery<RecordLike>(
      `MATCH (n:Entity) WHERE n.group_id IS NOT NULL
       RETURN collect(DISTINCT n.group_id) AS group_ids`,
      { routing: 'r' }
    );
    const firstRecord = result.records[0];
    resolvedGroupIds = firstRecord !== undefined
      ? (getRecordValue<string[]>(firstRecord, 'group_ids') ?? [])
      : [];
  }

  const allClusters: EntityNode[][] = [];

  for (const groupId of resolvedGroupIds) {
    // Project graph for this group
    try {
      await driver.executeQuery(
        `CALL gds.graph.project($name,
          {Entity: {properties: [], label: 'Entity'}},
          {RELATES_TO: {orientation: 'UNDIRECTED', type: 'RELATES_TO'}},
          {nodeFilter: 'n.group_id = "' + groupId + '"'}
        )`,
        { params: { name: graphName } }
      );
    } catch {
      // nodeFilter syntax varies by GDS version — try without filter
      await driver.executeQuery(
        `CALL gds.graph.project($name, 'Entity',
          {RELATES_TO: {orientation: 'UNDIRECTED'}})`,
        { params: { name: graphName } }
      );
    }

    try {
      // Run Leiden
      const result = await driver.executeQuery<RecordLike>(
        `CALL gds.leiden.stream($name)
         YIELD nodeId, communityId
         WITH communityId, collect(gds.util.asNode(nodeId).uuid) AS uuids, count(*) AS size
         WHERE size > 1
         RETURN uuids`,
        { params: { name: graphName } }
      );

      for (const record of result.records) {
        const uuids = getRecordValue<string[]>(record, 'uuids') ?? [];
        if (uuids.length > 0) {
          const entities = await entityNodes.getByUuids(uuids);
          if (entities.length > 0) {
            allClusters.push(entities);
          }
        }
      }
    } finally {
      // Always drop projection
      try {
        await driver.executeQuery(
          `CALL gds.graph.drop($name)`,
          { params: { name: graphName } }
        );
      } catch { /* already dropped or never created */ }
    }
  }

  return allClusters;
}

// ---------------------------------------------------------------------------
// LLM Summarization
// ---------------------------------------------------------------------------

function parseJsonField(text: string, field: string): string {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed[field] === 'string' ? parsed[field] : text.trim();
  } catch {
    return text.trim();
  }
}

function parseJsonArray(text: string, field: string): string[] {
  try {
    // Try direct parse
    let parsed = JSON.parse(text);
    // Handle wrapper object: { "results": [...] }
    if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
      // Find the first array field
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) {
          parsed = val;
          break;
        }
      }
    }
    if (Array.isArray(parsed)) {
      return parsed.map((item: unknown) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null && field in item) {
          return String((item as Record<string, unknown>)[field]);
        }
        return String(item);
      });
    }
    return [];
  } catch {
    // Try to extract JSON from markdown code fences
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return parseJsonArray(match[1]!, field);
    return [];
  }
}

export async function summarizePair(
  llmClient: LLMClient,
  summaryPair: [string, string]
): Promise<string> {
  const messages = summarizePairPrompt(summaryPair);
  const response = await llmClient.generateText(messages);
  return parseJsonField(response, 'summary');
}

export async function generateSummaryDescription(
  llmClient: LLMClient,
  summary: string
): Promise<string> {
  const messages = summaryDescriptionPrompt(summary);
  const response = await llmClient.generateText(messages);
  return parseJsonField(response, 'description');
}

/**
 * Summarize multiple communities in a single LLM call.
 * Each community is represented by its member entity summaries.
 * Returns one summary per community, in order.
 */
export async function batchSummarize(
  llmClient: LLMClient,
  communities: string[][]
): Promise<string[]> {
  if (communities.length === 0) return [];
  if (communities.length === 1 && communities[0]!.length <= 2) {
    // Single community with 1-2 members — use simple pair summarization
    const summaries = communities[0]!;
    if (summaries.length === 1) return [summaries[0]!];
    return [await summarizePair(llmClient, [summaries[0]!, summaries[1]!])];
  }

  const messages = batchSummarizePrompt(communities);
  const response = await llmClient.generateText(messages);
  const results = parseJsonArray(response, 'summary');

  // Validate we got the right count
  if (results.length !== communities.length) {
    // Fallback: summarize each community individually
    const fallback: string[] = [];
    for (const memberSummaries of communities) {
      if (memberSummaries.length === 0) {
        fallback.push('');
      } else if (memberSummaries.length === 1) {
        fallback.push(memberSummaries[0]!);
      } else {
        // Reduce to single summary via pairs
        let current = memberSummaries;
        while (current.length > 1) {
          const pair: [string, string] = [current[0]!, current[1]!];
          const merged = await summarizePair(llmClient, pair);
          current = [merged, ...current.slice(2)];
        }
        fallback.push(current[0]!);
      }
    }
    return fallback;
  }

  return results;
}

/**
 * Generate names for multiple communities in a single LLM call.
 * Returns one short name per summary, in order.
 */
export async function batchGenerateNames(
  llmClient: LLMClient,
  summaries: string[]
): Promise<string[]> {
  if (summaries.length === 0) return [];
  if (summaries.length === 1) {
    return [await generateSummaryDescription(llmClient, summaries[0]!)];
  }

  const messages = batchNamePrompt(summaries);
  const response = await llmClient.generateText(messages);
  const results = parseJsonArray(response, 'name');

  if (results.length !== summaries.length) {
    // Fallback: name each individually
    const fallback: string[] = [];
    for (const summary of summaries) {
      fallback.push(await generateSummaryDescription(llmClient, summary));
    }
    return fallback;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Build Community Edges
// ---------------------------------------------------------------------------

export function buildCommunityEdges(
  entityNodes: EntityNode[],
  communityNode: CommunityNode,
  createdAt: Date
): CommunityEdge[] {
  return entityNodes.map((node) => ({
    uuid: randomUUID(),
    source_node_uuid: communityNode.uuid,
    target_node_uuid: node.uuid,
    created_at: createdAt,
    group_id: communityNode.group_id
  }));
}

// ---------------------------------------------------------------------------
// Build Single Community
// ---------------------------------------------------------------------------

export async function buildCommunity(
  llmClient: LLMClient,
  communityCluster: EntityNode[]
): Promise<[CommunityNode, CommunityEdge[]]> {
  let summaries = communityCluster.map((entity) => entity.summary);
  let length = summaries.length;

  while (length > 1) {
    let oddOneOut: string | undefined;
    if (length % 2 === 1) {
      oddOneOut = summaries.pop();
      length -= 1;
    }

    const half = Math.floor(length / 2);
    const pairs: [string, string][] = [];
    for (let i = 0; i < half; i++) {
      pairs.push([summaries[i]!, summaries[half + i]!]);
    }

    // Serialize pair summarization to avoid overwhelming LLM backends
    const newSummaries: string[] = [];
    for (const pair of pairs) {
      newSummaries.push(await summarizePair(llmClient, pair));
    }

    if (oddOneOut !== undefined) {
      newSummaries.push(oddOneOut);
    }

    summaries = newSummaries;
    length = summaries.length;
  }

  const summary = summaries[0] ?? '';
  const name = await generateSummaryDescription(llmClient, summary);
  const now = utcNow();
  const firstEntity = communityCluster[0];
  if (firstEntity === undefined) {
    throw new Error('communityCluster must not be empty');
  }

  const communityNode: CommunityNode = {
    uuid: randomUUID(),
    name,
    group_id: firstEntity.group_id,
    labels: ['Community'],
    created_at: now,
    summary
  };

  const communityEdges = buildCommunityEdges(communityCluster, communityNode, now);
  return [communityNode, communityEdges];
}

// ---------------------------------------------------------------------------
// Build All Communities
// ---------------------------------------------------------------------------

/**
 * Build communities using the best available algorithm:
 *   1. Neo4j GDS Leiden (if GDS plugin installed) — milliseconds, better quality
 *   2. Application-level label propagation (fallback) — slower, requires N+1 queries
 *
 * Summarization uses batched LLM calls — all communities summarized in a few calls
 * instead of N-1 per community.
 */
export async function buildCommunities(
  driver: GraphDriver,
  llmClient: LLMClient,
  entityNodes: EntityNodeNamespaceReader,
  groupIds: string[] | null
): Promise<[CommunityNode[], CommunityEdge[]]> {
  // Phase 1: Detect communities
  let communityClusters: EntityNode[][];
  const gdsAvailable = await hasGDS(driver);

  if (gdsAvailable) {
    console.log('[communities] Using Neo4j GDS Leiden algorithm');
    communityClusters = await getCommunityClustersGDS(driver, entityNodes, groupIds);
  } else {
    console.log('[communities] GDS not available, falling back to label propagation');
    communityClusters = await getCommunityClusters(driver, entityNodes, groupIds);
  }

  // Filter out empty clusters
  communityClusters = communityClusters.filter((c) => c.length > 0);

  if (communityClusters.length === 0) {
    return [[], []];
  }

  console.log(`[communities] ${communityClusters.length} clusters detected, summarizing...`);

  // Phase 2: Batched summarization
  // Prepare member summaries for each community (capped at MAX_MEMBERS_PER_SUMMARY)
  const allMemberSummaries: string[][] = communityClusters.map((cluster) =>
    cluster.slice(0, MAX_MEMBERS_PER_SUMMARY).map((e) => e.summary)
  );

  // Process in batches of MAX_BATCH_SIZE
  const allSummaries: string[] = [];
  for (let i = 0; i < allMemberSummaries.length; i += MAX_BATCH_SIZE) {
    const batch = allMemberSummaries.slice(i, i + MAX_BATCH_SIZE);
    const batchSummaries = await batchSummarize(llmClient, batch);
    allSummaries.push(...batchSummaries);
  }

  // Phase 3: Batched name generation
  const allNames: string[] = [];
  for (let i = 0; i < allSummaries.length; i += MAX_BATCH_SIZE) {
    const batch = allSummaries.slice(i, i + MAX_BATCH_SIZE);
    const batchNames = await batchGenerateNames(llmClient, batch);
    allNames.push(...batchNames);
  }

  // Phase 4: Assemble community nodes and edges
  const now = utcNow();
  const communityNodes: CommunityNode[] = [];
  const communityEdges: CommunityEdge[] = [];

  for (let i = 0; i < communityClusters.length; i++) {
    const cluster = communityClusters[i]!;
    const firstEntity = cluster[0]!;

    const communityNode: CommunityNode = {
      uuid: randomUUID(),
      name: allNames[i] ?? `Community ${i + 1}`,
      group_id: firstEntity.group_id,
      labels: ['Community'],
      created_at: now,
      summary: allSummaries[i] ?? '',
    };

    communityNodes.push(communityNode);
    communityEdges.push(...buildCommunityEdges(cluster, communityNode, now));
  }

  const summaryLLMCalls = Math.ceil(allMemberSummaries.length / MAX_BATCH_SIZE);
  const nameLLMCalls = Math.ceil(allSummaries.length / MAX_BATCH_SIZE);
  console.log(`[communities] Built ${communityNodes.length} communities (${summaryLLMCalls + nameLLMCalls} LLM calls)`);

  return [communityNodes, communityEdges];
}

// ---------------------------------------------------------------------------
// Remove Communities
// ---------------------------------------------------------------------------

export async function removeCommunities(driver: GraphDriver): Promise<void> {
  await driver.executeQuery(`
    MATCH (c:Community)
    DETACH DELETE c
  `);
}

// ---------------------------------------------------------------------------
// Determine Entity Community (incremental)
// ---------------------------------------------------------------------------

export async function determineEntityCommunity(
  driver: GraphDriver,
  entity: EntityNode
): Promise<[CommunityNode | null, boolean]> {
  // Check if entity is already part of a community
  const existingResult = await driver.executeQuery<RecordLike>(
    `
      MATCH (c:Community)-[:HAS_MEMBER]->(n:Entity {uuid: $entity_uuid})
      RETURN
        c.uuid AS uuid,
        c.name AS name,
        c.group_id AS group_id,
        coalesce(c.labels, labels(c)) AS labels,
        c.created_at AS created_at,
        c.summary AS summary,
        c.name_embedding AS name_embedding,
        c.rank AS rank
    `,
    { params: { entity_uuid: entity.uuid }, routing: 'r' }
  );

  const existingRecord = existingResult.records[0];
  if (existingRecord !== undefined) {
    return [mapCommunityNode(existingRecord), false];
  }

  // If not, find the mode community among neighbors
  const neighborResult = await driver.executeQuery<RecordLike>(
    `
      MATCH (c:Community)-[:HAS_MEMBER]->(m:Entity)-[:RELATES_TO]-(n:Entity {uuid: $entity_uuid})
      RETURN
        c.uuid AS uuid,
        c.name AS name,
        c.group_id AS group_id,
        coalesce(c.labels, labels(c)) AS labels,
        c.created_at AS created_at,
        c.summary AS summary,
        c.name_embedding AS name_embedding,
        c.rank AS rank
    `,
    { params: { entity_uuid: entity.uuid }, routing: 'r' }
  );

  const communities = neighborResult.records.map((record) => mapCommunityNode(record));

  const communityCountMap = new Map<string, number>();
  for (const community of communities) {
    communityCountMap.set(community.uuid, (communityCountMap.get(community.uuid) ?? 0) + 1);
  }

  let bestUuid: string | null = null;
  let maxCount = 0;
  for (const [uuid, count] of communityCountMap) {
    if (count > maxCount) {
      bestUuid = uuid;
      maxCount = count;
    }
  }

  if (maxCount === 0) {
    return [null, false];
  }

  for (const community of communities) {
    if (community.uuid === bestUuid) {
      return [community, true];
    }
  }

  return [null, false];
}

// ---------------------------------------------------------------------------
// Update Community (incremental)
// ---------------------------------------------------------------------------

export interface CommunityNamespaceWriter {
  node: {
    save(node: CommunityNode): Promise<CommunityNode>;
  };
  edge: {
    save(edge: CommunityEdge): Promise<CommunityEdge>;
  };
}

export async function updateCommunity(
  driver: GraphDriver,
  llmClient: LLMClient,
  embedder: EmbedderClient,
  communityNamespace: CommunityNamespaceWriter,
  entity: EntityNode
): Promise<[CommunityNode[], CommunityEdge[]]> {
  const [community, isNew] = await determineEntityCommunity(driver, entity);

  if (community === null) {
    return [[], []];
  }

  const newSummary = await summarizePair(llmClient, [entity.summary, community.summary]);
  const newName = await generateSummaryDescription(llmClient, newSummary);

  community.summary = newSummary;
  community.name = newName;

  const communityEdges: CommunityEdge[] = [];
  if (isNew) {
    const edges = buildCommunityEdges([entity], community, utcNow());
    const firstEdge = edges[0]!;
    await communityNamespace.edge.save(firstEdge);
    communityEdges.push(firstEdge);
  }

  community.name_embedding = await embedder.create([community.name.replaceAll('\n', ' ')]);
  await communityNamespace.node.save(community);

  return [[community], communityEdges];
}
