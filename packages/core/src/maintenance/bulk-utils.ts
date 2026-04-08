/**
 * Bulk utilities — port of Python's utils/bulk_utils.py.
 *
 * Core functions:
 * - addNodesAndEdgesBulk(): Persist episodes, nodes, and edges in bulk
 * - dedupeNodesBulk(): Cross-episode node deduplication
 * - dedupeEdgesBulk(): Cross-episode edge deduplication
 * - extractNodesAndEdgesBulk(): Parallel extraction across episodes
 */

import { GraphProviders } from '@graphiti/shared';

import type { GraphitiClients, EmbedderClient, GraphDriver } from '../contracts';
import type { DeprecationGateConfig } from '../domain/deprecation-gate';
import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { semaphoreGather } from '../utils/concurrency';
import { normalizeStringExact, buildCandidateIndexes, resolveWithSimilarity, type DedupResolutionState } from '../dedup/dedup-helpers';
import { buildDirectedUuidMap } from '../dedup/union-find';
import { extractNodes, resolveExtractedNodes, type EntityTypeDefinition } from './node-operations';
import { extractEdges, resolveEdgePointers as resolveEdgePointersOp, resolveExtractedEdge, type EdgeTypeDefinition } from './edge-operations';
import type { SearchFilters } from '../search/filters';
import { serializeForCypher, serializeForFalkor } from '../utils/serialization';

export interface RawEpisode {
  name: string;
  uuid?: string | null;
  content: string;
  source_description: string;
  source: import('../domain/nodes').EpisodeType;
  reference_time: Date;
}

export interface BulkEmbeddingOptions {
  prefer_batch_embeddings?: boolean;
}

async function generateNodeEmbeddings(
  entityNodes: EntityNode[],
  embedder: EmbedderClient,
  options: BulkEmbeddingOptions
): Promise<void> {
  const pendingNodes = entityNodes.filter((n) => !n.name_embedding);
  if (pendingNodes.length === 0) {
    return;
  }

  const prefersBatch = options.prefer_batch_embeddings !== false;
  if (prefersBatch && embedder.createBatch) {
    const embeddings = await embedder.createBatch(
      pendingNodes.map((node) => node.name.replaceAll('\n', ' '))
    );
    for (let i = 0; i < pendingNodes.length; i++) {
      pendingNodes[i]!.name_embedding = embeddings[i] ?? null;
    }
    return;
  }

  await semaphoreGather(
    pendingNodes.map((node) => async () => {
      node.name_embedding = await embedder.create([node.name.replaceAll('\n', ' ')]);
    })
  );
}

async function generateEdgeEmbeddings(
  entityEdges: EntityEdge[],
  embedder: EmbedderClient,
  options: BulkEmbeddingOptions
): Promise<void> {
  const pendingEdges = entityEdges.filter((e) => !e.fact_embedding);
  if (pendingEdges.length === 0) {
    return;
  }

  const prefersBatch = options.prefer_batch_embeddings !== false;
  if (prefersBatch && embedder.createBatch) {
    const embeddings = await embedder.createBatch(
      pendingEdges.map((edge) => edge.fact.replaceAll('\n', ' '))
    );
    for (let i = 0; i < pendingEdges.length; i++) {
      pendingEdges[i]!.fact_embedding = embeddings[i] ?? null;
    }
    return;
  }

  await semaphoreGather(
    pendingEdges.map((edge) => async () => {
      edge.fact_embedding = await embedder.create([edge.fact.replaceAll('\n', ' ')]);
    })
  );
}

// -------------------------------------------------------------------------
// addNodesAndEdgesBulk()
// -------------------------------------------------------------------------

export async function addNodesAndEdgesBulk(
  driver: GraphDriver,
  episodicNodes: EpisodicNode[],
  episodicEdges: EpisodicEdge[],
  entityNodes: EntityNode[],
  entityEdges: EntityEdge[],
  embedder: EmbedderClient,
  options: BulkEmbeddingOptions = {}
): Promise<void> {
  const serialize =
    driver.provider === GraphProviders.FALKORDB ? serializeForFalkor : serializeForCypher;

  await generateNodeEmbeddings(entityNodes, embedder, options);
  await generateEdgeEmbeddings(entityEdges, embedder, options);

  // Save episodes
  for (const episode of episodicNodes) {
    await driver.executeQuery(
      `
      MERGE (e:Episodic {uuid: $episode.uuid})
      SET e += $episode
      SET e.labels = $labels
      RETURN e.uuid AS uuid
      `,
      {
        params: {
          episode: serialize({
            ...episode,
            labels: undefined
          }),
          labels: episode.labels
        }
      }
    );
  }

  // Save entity nodes
  for (const node of entityNodes) {
    await driver.executeQuery(
      `
      MERGE (n:Entity {uuid: $entity.uuid})
      SET n += $entity
      SET n.labels = $labels
      RETURN n.uuid AS uuid
      `,
      {
        params: {
          entity: serialize({
            ...node,
            labels: undefined
          }),
          labels: node.labels
        }
      }
    );
  }

  // Save episodic edges (MENTIONS)
  for (const edge of episodicEdges) {
    await driver.executeQuery(
      `
      MATCH (source:Episodic {uuid: $source_uuid})
      MATCH (target:Entity {uuid: $target_uuid})
      MERGE (source)-[e:MENTIONS {uuid: $edge.uuid}]->(target)
      SET e += $edge
      RETURN e.uuid AS uuid
      `,
      {
        params: {
          source_uuid: edge.source_node_uuid,
          target_uuid: edge.target_node_uuid,
          edge: serialize(edge)
        }
      }
    );
  }

  // Save entity edges (RELATES_TO)
  for (const edge of entityEdges) {
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
          edge: serialize(edge)
        }
      }
    );
  }
}

// -------------------------------------------------------------------------
// extractNodesAndEdgesBulk()
// -------------------------------------------------------------------------

export async function extractNodesAndEdgesBulk(
  clients: GraphitiClients,
  episodeTuples: Array<[EpisodicNode, EpisodicNode[]]>,
  edgeTypeMap: Record<string, string[]>,
  entityTypes?: Record<string, EntityTypeDefinition> | null,
  excludedEntityTypes?: string[] | null,
  edgeTypes?: Record<string, EdgeTypeDefinition> | null,
  customExtractionInstructions?: string | null,
  resolveCustomExtractionInstructions?: ((episode: EpisodicNode) => string | null) | null
): Promise<[EntityNode[][], EntityEdge[][]]> {
  // Extract nodes for each episode
  const extractedNodesBulk: EntityNode[][] = await semaphoreGather(
    episodeTuples.map(
      ([episode, previousEpisodes]) =>
        () =>
          extractNodes(
            clients,
            episode,
            previousEpisodes,
            entityTypes,
            excludedEntityTypes,
            customExtractionInstructions ??
              resolveCustomExtractionInstructions?.(episode) ??
              null
          )
    )
  );

  // Extract edges for each episode
  const extractedEdgesBulk: EntityEdge[][] = await semaphoreGather(
    episodeTuples.map(
      ([episode, previousEpisodes], i) =>
        () =>
          extractEdges(
            clients,
            episode,
            extractedNodesBulk[i]!,
            previousEpisodes,
            edgeTypeMap,
            episode.group_id,
            edgeTypes,
            customExtractionInstructions ??
              resolveCustomExtractionInstructions?.(episode) ??
              null
          )
    )
  );

  return [extractedNodesBulk, extractedEdgesBulk];
}

// -------------------------------------------------------------------------
// dedupeNodesBulk()
// -------------------------------------------------------------------------

export async function dedupeNodesBulk(
  clients: GraphitiClients,
  extractedNodes: EntityNode[][],
  episodeTuples: Array<[EpisodicNode, EpisodicNode[]]>,
  entityTypes?: Record<string, EntityTypeDefinition> | null
): Promise<[Record<string, EntityNode[]>, Record<string, string>]> {
  // First pass: resolve each episode's nodes against the graph
  const firstPassResults = await semaphoreGather(
    extractedNodes.map(
      (nodes, i) =>
        () =>
          resolveExtractedNodes(
            clients,
            nodes,
            episodeTuples[i]![0],
            episodeTuples[i]![1],
            entityTypes
          )
    )
  );

  const episodeResolutions: Array<[string, EntityNode[]]> = [];
  const perEpisodeUuidMaps: Array<Record<string, string>> = [];
  const duplicatePairs: Array<[string, string]> = [];

  for (let i = 0; i < firstPassResults.length; i++) {
    const [resolvedNodes, uuidMap, duplicates] = firstPassResults[i]!;
    const [episode] = episodeTuples[i]!;
    episodeResolutions.push([episode.uuid, resolvedNodes]);
    perEpisodeUuidMaps.push(uuidMap);
    for (const [source, target] of duplicates) {
      duplicatePairs.push([source.uuid, target.uuid]);
    }
  }

  // Second pass: cross-episode dedup using similarity heuristics
  const canonicalNodes = new Map<string, EntityNode>();
  for (const [, resolvedNodes] of episodeResolutions) {
    for (const node of resolvedNodes) {
      if (canonicalNodes.size === 0) {
        canonicalNodes.set(node.uuid, node);
        continue;
      }

      const existing = Array.from(canonicalNodes.values());
      const normalized = normalizeStringExact(node.name);
      const exactMatch = existing.find(
        (c) => normalizeStringExact(c.name) === normalized
      );

      if (exactMatch) {
        if (exactMatch.uuid !== node.uuid) {
          duplicatePairs.push([node.uuid, exactMatch.uuid]);
        }
        continue;
      }

      const indexes = buildCandidateIndexes(existing);
      const state: DedupResolutionState = {
        resolvedNodes: [null],
        uuidMap: new Map(),
        unresolvedIndices: [],
        duplicatePairs: []
      };
      resolveWithSimilarity([node], indexes, state);

      const resolved = state.resolvedNodes[0];
      if (!resolved) {
        canonicalNodes.set(node.uuid, node);
      } else {
        canonicalNodes.set(resolved.uuid, canonicalNodes.get(resolved.uuid) ?? resolved);
        if (resolved.uuid !== node.uuid) {
          duplicatePairs.push([node.uuid, resolved.uuid]);
        }
      }
    }
  }

  // Build compressed UUID map
  const unionPairs: Array<[string, string]> = [];
  for (const uuidMap of perEpisodeUuidMaps) {
    for (const [source, target] of Object.entries(uuidMap)) {
      unionPairs.push([source, target]);
    }
  }
  unionPairs.push(...duplicatePairs);

  const compressedMap: Record<string, string> = Object.fromEntries(
    unionPairs.length > 0
      ? buildDirectedUuidMap(unionPairs)
      : new Map()
  );

  // Build nodes-by-episode
  const nodesByEpisode: Record<string, EntityNode[]> = {};
  for (const [episodeUuid, resolvedNodes] of episodeResolutions) {
    const dedupedNodes: EntityNode[] = [];
    const seen = new Set<string>();
    for (const node of resolvedNodes) {
      const canonicalUuid = compressedMap[node.uuid] ?? node.uuid;
      if (seen.has(canonicalUuid)) continue;
      seen.add(canonicalUuid);
      const canonicalNode = canonicalNodes.get(canonicalUuid) ?? node;
      dedupedNodes.push(canonicalNode);
    }
    nodesByEpisode[episodeUuid] = dedupedNodes;
  }

  return [nodesByEpisode, compressedMap];
}

// -------------------------------------------------------------------------
// dedupeEdgesBulk()
// -------------------------------------------------------------------------

export async function dedupeEdgesBulk(
  clients: GraphitiClients,
  extractedEdges: EntityEdge[][],
  episodeTuples: Array<[EpisodicNode, EpisodicNode[]]>,
  edgeTypes: Record<string, EdgeTypeDefinition>,
  options: {
    deprecation_gate_config?: DeprecationGateConfig;
    prefer_batch_embeddings?: boolean;
  } = {}
): Promise<Record<string, EntityEdge[]>> {
  const embedder = clients.embedder;
  const minScore = 0.6;

  // Generate embeddings
  for (const edges of extractedEdges) {
    const pendingEdges = edges.filter((e) => !e.fact_embedding);
    if (
      options.prefer_batch_embeddings !== false &&
      embedder.createBatch &&
      pendingEdges.length > 0
    ) {
      const embeddings = await embedder.createBatch(
        pendingEdges.map((edge) => edge.fact.replaceAll('\n', ' '))
      );
      for (let i = 0; i < pendingEdges.length; i++) {
        pendingEdges[i]!.fact_embedding = embeddings[i] ?? null;
      }
    } else {
      await semaphoreGather(
        pendingEdges.map((edge) => async () => {
          edge.fact_embedding = await embedder.create([edge.fact.replaceAll('\n', ' ')]);
        })
      );
    }
  }

  // Find similar candidates and resolve
  const dedupeTuples: Array<[EpisodicNode, EntityEdge, EntityEdge[]]> = [];
  const allEdges = extractedEdges.flat();

  for (let i = 0; i < extractedEdges.length; i++) {
    const episode = episodeTuples[i]![0];
    for (const edge of extractedEdges[i]!) {
      const candidates: EntityEdge[] = [];
      for (const existing of allEdges) {
        if (edge.uuid === existing.uuid) continue;
        if (
          edge.source_node_uuid !== existing.source_node_uuid ||
          edge.target_node_uuid !== existing.target_node_uuid
        ) {
          continue;
        }

        // Word overlap check
        const edgeWords = new Set(edge.fact.toLowerCase().split(/\s+/));
        const existingWords = new Set(existing.fact.toLowerCase().split(/\s+/));
        let hasOverlap = false;
        for (const w of edgeWords) {
          if (existingWords.has(w)) {
            hasOverlap = true;
            break;
          }
        }

        if (hasOverlap) {
          candidates.push(existing);
          continue;
        }

        // Cosine similarity check
        if (edge.fact_embedding && existing.fact_embedding) {
          const dotProduct = edge.fact_embedding.reduce(
            (sum, val, idx) => sum + val * (existing.fact_embedding![idx] ?? 0),
            0
          );
          if (dotProduct >= minScore) {
            candidates.push(existing);
          }
        }
      }

      dedupeTuples.push([episode, edge, candidates]);
    }
  }

  // Resolve duplicates
  const resolutions = await semaphoreGather(
    dedupeTuples.map(
      ([episode, edge, candidates]) =>
        () =>
          resolveExtractedEdge(
            clients.llm_client,
            edge,
            candidates,
            candidates,
            episode,
            edgeTypes,
            undefined,
            options.deprecation_gate_config
          )
    )
  );

  // Build duplicate pairs from resolutions
  const duplicatePairs: Array<[string, string]> = [];
  for (let i = 0; i < resolutions.length; i++) {
    const [resolvedEdge] = resolutions[i]!;
    const [, originalEdge] = dedupeTuples[i]!;
    if (resolvedEdge.uuid !== originalEdge.uuid) {
      duplicatePairs.push([originalEdge.uuid, resolvedEdge.uuid]);
    }
  }

  // Compress UUID map
  const compressedMap = compressUuidMap(duplicatePairs);

  // Build edges-by-episode
  const edgeUuidMap = new Map<string, EntityEdge>();
  for (const edges of extractedEdges) {
    for (const edge of edges) {
      edgeUuidMap.set(edge.uuid, edge);
    }
  }

  const edgesByEpisode: Record<string, EntityEdge[]> = {};
  for (let i = 0; i < extractedEdges.length; i++) {
    const episode = episodeTuples[i]![0];
    edgesByEpisode[episode.uuid] = extractedEdges[i]!.map(
      (edge) => edgeUuidMap.get(compressedMap[edge.uuid] ?? edge.uuid) ?? edge
    );
  }

  return edgesByEpisode;
}

// -------------------------------------------------------------------------
// compress UUID map (union-find)
// -------------------------------------------------------------------------

function compressUuidMap(pairs: Array<[string, string]>): Record<string, string> {
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = x;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  for (const [a, b] of pairs) {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    const ra = find(a);
    const rb = find(b);
    if (ra < rb) {
      parent.set(rb, ra);
    } else {
      parent.set(ra, rb);
    }
  }

  const result: Record<string, string> = {};
  for (const uuid of parent.keys()) {
    result[uuid] = find(uuid);
  }
  return result;
}
