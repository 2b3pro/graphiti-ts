import { randomUUID } from 'node:crypto';

import { utcNow } from '@graphiti/shared';

import type { EmbedderClient, GraphDriver, LLMClient } from '../contracts';
import type { CommunityEdge } from '../domain/edges';
import type { CommunityNode, EntityNode } from '../domain/nodes';
import type { RecordLike } from '../utils/records';
import { getRecordValue } from '../utils/records';
import { mapCommunityNode } from '../namespaces/communities';
import { summarizePairPrompt, summaryDescriptionPrompt } from './prompts';

export const MAX_COMMUNITY_BUILD_CONCURRENCY = 10;

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

    const newSummaries = await Promise.all(
      pairs.map((pair) => summarizePair(llmClient, pair))
    );

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

export async function buildCommunities(
  driver: GraphDriver,
  llmClient: LLMClient,
  entityNodes: EntityNodeNamespaceReader,
  groupIds: string[] | null
): Promise<[CommunityNode[], CommunityEdge[]]> {
  const communityClusters = await getCommunityClusters(driver, entityNodes, groupIds);

  // Concurrency-limited building: process in batches of MAX_COMMUNITY_BUILD_CONCURRENCY
  const results: [CommunityNode, CommunityEdge[]][] = [];

  for (let i = 0; i < communityClusters.length; i += MAX_COMMUNITY_BUILD_CONCURRENCY) {
    const batch = communityClusters.slice(i, i + MAX_COMMUNITY_BUILD_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((cluster) => buildCommunity(llmClient, cluster))
    );
    results.push(...batchResults);
  }

  const communityNodes: CommunityNode[] = [];
  const communityEdges: CommunityEdge[] = [];
  for (const [node, edges] of results) {
    communityNodes.push(node);
    communityEdges.push(...edges);
  }

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
