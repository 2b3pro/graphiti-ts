/**
 * Edge extraction and resolution — port of Python's utils/maintenance/edge_operations.py.
 *
 * Core functions:
 * - extractEdges(): Extract entity edges from an episode via LLM
 * - resolveExtractedEdges(): Resolve extracted edges against existing graph
 * - resolveExtractedEdge(): Resolve a single edge (dedup + contradiction detection)
 * - buildEpisodicEdges(): Build MENTIONS edges between episode and entity nodes
 * - resolveEdgePointers(): Update edge source/target UUIDs based on node dedup map
 */

import { utcNow } from '@graphiti/shared';

import type { GraphitiClients, LLMClient, EmbedderClient, GenerateResponseOptions } from '../contracts';
import type { GraphitiResolutionConfig } from '../config';
import { logResolutionDecision } from '../config';
import type { Tracer } from '../tracing';
import { ENTITY_EDGE_RETURN_FIELDS } from '../driver/cypher-fields';
import { detectNegation } from './negation';
import { generateResponse as defaultGenerateResponse, type GenerateResponseContext } from '../llm/generate-response';
import type { EntityEdge, EpisodicEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { promptLibrary } from '../prompts/lib';
import type { ExtractedEdge, ExtractedEdges, EdgeDuplicate } from '../prompts/models';
import { search } from '../search/search';
import { createSearchFilters, type SearchFilters } from '../search/filters';
import { EDGE_HYBRID_SEARCH_RRF } from '../search/recipes';
import { normalizeStringExact } from '../dedup/dedup-helpers';
import { semaphoreGather } from '../utils/concurrency';
import type { EntityTypeDefinition } from './node-operations';
import { computeEvidenceWeight } from '../domain/epistemic';
import {
  resolveContradiction as resolveContradictionGate,
  type ContradictionScores,
  type DeprecationGateConfig
} from '../domain/deprecation-gate';

/** Build a GenerateResponseContext from GraphitiClients. */
function buildEdgeContext(clients: GraphitiClients): GenerateResponseContext {
  return {
    tokenTracker: clients.tokenTracker ?? null,
    cache: clients.cache ?? null,
    modelRouting: clients.modelRouting ?? null,
  };
}

/** Call generateResponse on the client, falling back to default implementation if not provided. */
async function callGenerateResponse(
  client: LLMClient,
  messages: import('../prompts/types').Message[],
  options?: GenerateResponseOptions,
  context?: GenerateResponseContext
): Promise<Record<string, unknown>> {
  if (client.generateResponse) {
    return client.generateResponse(messages, options, context);
  }
  return defaultGenerateResponse(client, messages, options, context);
}

// -------------------------------------------------------------------------
// buildEpisodicEdges()
// -------------------------------------------------------------------------

export function buildEpisodicEdges(
  entityNodes: EntityNode[],
  episodeUuid: string,
  createdAt: Date
): EpisodicEdge[] {
  return entityNodes.map((node) => ({
    uuid: `${episodeUuid}:${node.uuid}`,
    group_id: node.group_id,
    source_node_uuid: episodeUuid,
    target_node_uuid: node.uuid,
    created_at: createdAt
  }));
}

// -------------------------------------------------------------------------
// resolveEdgePointers()
// -------------------------------------------------------------------------

export function resolveEdgePointers(
  edges: EntityEdge[],
  uuidMap: Record<string, string>
): EntityEdge[] {
  return edges.map((edge) => ({
    ...edge,
    source_node_uuid: uuidMap[edge.source_node_uuid] ?? edge.source_node_uuid,
    target_node_uuid: uuidMap[edge.target_node_uuid] ?? edge.target_node_uuid
  }));
}

// -------------------------------------------------------------------------
// extractEdges()
// -------------------------------------------------------------------------

export interface EdgeTypeDefinition {
  description?: string;
  fields?: Record<string, unknown>;
}

export async function extractEdges(
  clients: GraphitiClients,
  episode: EpisodicNode,
  nodes: EntityNode[],
  previousEpisodes: EpisodicNode[],
  edgeTypeMap: Record<string, string[]>,
  groupId: string,
  edgeTypes?: Record<string, EdgeTypeDefinition> | null,
  customExtractionInstructions?: string | null
): Promise<EntityEdge[]> {
  const llmClient = clients.llm_client;

  // Build mapping from edge type name to list of valid node-type signatures
  const edgeTypeSignaturesMap: Record<string, string[][]> = {};
  for (const [signature, edgeTypeNames] of Object.entries(edgeTypeMap)) {
    const sigParts = signature.split(',');
    for (const edgeType of edgeTypeNames) {
      if (!edgeTypeSignaturesMap[edgeType]) {
        edgeTypeSignaturesMap[edgeType] = [];
      }
      edgeTypeSignaturesMap[edgeType]!.push(sigParts);
    }
  }

  // Build edge types context including signatures
  const edgeTypesContext = edgeTypes
    ? Object.entries(edgeTypes).map(([typeName, typeDef]) => ({
        fact_type_name: typeName,
        fact_type_signatures: edgeTypeSignaturesMap[typeName] ?? [['Entity', 'Entity']],
        fact_type_description: typeDef.description ?? `Edge type: ${typeName}`
      }))
    : [];

  // Build name-to-node mapping for validation
  const nameToNode = new Map<string, EntityNode>();
  for (const node of nodes) {
    nameToNode.set(node.name, node);
  }

  const context: Record<string, unknown> = {
    current_message: episode.content,
    previous_messages: previousEpisodes.map((ep) => ep.content).join('\n'),
    entities: JSON.stringify(nodes.map((n) => ({ name: n.name, entity_types: n.labels }))),
    reference_time: (episode.valid_at ?? episode.created_at).toISOString(),
    fact_types: edgeTypesContext.length > 0 ? JSON.stringify(edgeTypesContext) : null,
    custom_extraction_instructions: customExtractionInstructions ?? ''
  };

  const llmResponse = await callGenerateResponse(llmClient,
    promptLibrary.extractEdges.extractEdges(context),
    {
      response_model: { type: 'object', properties: { edges: { type: 'array' } } },
      max_tokens: 16384,
      group_id: groupId,
      prompt_name: 'extract_edges.edge'
    },
    buildEdgeContext(clients)
  );

  const allEdgesData: ExtractedEdge[] =
    (llmResponse as unknown as ExtractedEdges).edges ?? [];

  // Validate entity names and create edges
  const edges: EntityEdge[] = [];
  const now = utcNow();

  for (const edgeData of allEdgesData) {
    if (!edgeData.fact?.trim()) continue;

    const sourceNode = nameToNode.get(edgeData.source_entity_name);
    const targetNode = nameToNode.get(edgeData.target_entity_name);

    if (!sourceNode || !targetNode) continue;

    let validAt: Date | null = null;
    let invalidAt: Date | null = null;

    if (edgeData.valid_at) {
      try {
        validAt = new Date(edgeData.valid_at.replace('Z', '+00:00'));
      } catch {
        // Skip invalid date
      }
    }

    if (edgeData.invalid_at) {
      try {
        invalidAt = new Date(edgeData.invalid_at.replace('Z', '+00:00'));
      } catch {
        // Skip invalid date
      }
    }

    edges.push({
      uuid: crypto.randomUUID(),
      source_node_uuid: sourceNode.uuid,
      target_node_uuid: targetNode.uuid,
      name: edgeData.relation_type,
      group_id: groupId,
      fact: edgeData.fact.trim().replace(/[.!?,;:]+$/, ''),
      episodes: [episode.uuid],
      created_at: now,
      valid_at: validAt,
      invalid_at: invalidAt
    });
  }

  return edges;
}

// -------------------------------------------------------------------------
// resolveExtractedEdges()
// -------------------------------------------------------------------------

export async function resolveExtractedEdges(
  clients: GraphitiClients,
  extractedEdges: EntityEdge[],
  episode: EpisodicNode,
  entities: EntityNode[],
  edgeTypes: Record<string, EdgeTypeDefinition>,
  edgeTypeMap: Record<string, string[]>,
  deprecationGateConfig?: DeprecationGateConfig,
  resolutionConfig?: GraphitiResolutionConfig,
  maxConcurrency?: number | null
): Promise<[EntityEdge[], EntityEdge[], EntityEdge[]]> {
  if (extractedEdges.length === 0) {
    return [[], [], []];
  }

  // Fast path: deduplicate exact matches within extracted edges
  const seen = new Map<string, EntityEdge>();
  const deduplicatedEdges: EntityEdge[] = [];
  for (const edge of extractedEdges) {
    const key = `${edge.source_node_uuid}|${edge.target_node_uuid}|${normalizeStringExact(edge.fact)}`;
    if (!seen.has(key)) {
      seen.set(key, edge);
      deduplicatedEdges.push(edge);
    }
  }

  const driver = clients.driver;
  const llmClient = clients.llm_client;
  const embedder = clients.embedder;

  // Generate embeddings for extracted edges
  await createEntityEdgeEmbeddings(embedder, deduplicatedEdges);

  // Resolve concurrency limit from resolution config or explicit parameter
  const concurrencyLimit =
    resolutionConfig?.bulk_edge_resolution_max_concurrency ??
    (maxConcurrency !== null && maxConcurrency !== undefined ? maxConcurrency : undefined);

  // Get valid edges between node pairs
  const validEdgesLists: EntityEdge[][] = await semaphoreGather(
    deduplicatedEdges.map(
      (edge) => () => getEdgesBetweenNodes(driver, edge.source_node_uuid, edge.target_node_uuid)
    ),
    concurrencyLimit
  );

  // Search for related edges
  const relatedEdgesResults = await semaphoreGather(
    deduplicatedEdges.map(
      (extractedEdge, i) => () =>
        search(
          driver,
          extractedEdge.fact,
          [extractedEdge.group_id],
          EDGE_HYBRID_SEARCH_RRF,
          createSearchFilters({
            edge_uuids: validEdgesLists[i]?.map((e) => e.uuid) ?? []
          })
        )
    ),
    concurrencyLimit
  );

  const relatedEdgesLists = relatedEdgesResults.map((r) => r.edges);
  const relatedEdgeScoresLists = relatedEdgesResults.map((r) => r.edge_reranker_scores);

  // Search for invalidation candidates
  const invalidationResults = await semaphoreGather(
    deduplicatedEdges.map(
      (extractedEdge) => () =>
        search(
          driver,
          extractedEdge.fact,
          [extractedEdge.group_id],
          EDGE_HYBRID_SEARCH_RRF,
          createSearchFilters()
        )
    ),
    concurrencyLimit
  );

  // Remove duplicates between related edges and invalidation candidates
  const edgeInvalidationCandidates: EntityEdge[][] = [];
  for (let i = 0; i < relatedEdgesLists.length; i++) {
    const relatedUuids = new Set(relatedEdgesLists[i]!.map((e) => e.uuid));
    const deduplicated = invalidationResults[i]!.edges.filter(
      (edge) => !relatedUuids.has(edge.uuid)
    );
    edgeInvalidationCandidates.push(deduplicated);
  }

  // Build entity UUID lookup
  const uuidEntityMap = new Map<string, EntityNode>();
  for (const entity of entities) {
    uuidEntityMap.set(entity.uuid, entity);
  }

  // Resolve each edge
  const edgeCtx = buildEdgeContext(clients);
  const results = await semaphoreGather(
    deduplicatedEdges.map(
      (extractedEdge, i) => () =>
        resolveExtractedEdge(
          llmClient,
          extractedEdge,
          relatedEdgesLists[i]!,
          relatedEdgeScoresLists[i]!,
          edgeInvalidationCandidates[i]!,
          episode,
          edgeTypes,
          edgeCtx,
          deprecationGateConfig,
          resolutionConfig,
          clients.tracer
        )
    ),
    concurrencyLimit
  );

  const resolvedEdges: EntityEdge[] = [];
  const invalidatedEdges: EntityEdge[] = [];
  const newEdges: EntityEdge[] = [];

  for (let i = 0; i < deduplicatedEdges.length; i++) {
    const [resolvedEdge, invalidated] = results[i]!;
    resolvedEdges.push(resolvedEdge);
    invalidatedEdges.push(...invalidated);

    // An edge is new if the resolved UUID matches the extracted UUID
    if (resolvedEdge.uuid === deduplicatedEdges[i]!.uuid) {
      newEdges.push(resolvedEdge);
    }
  }

  // Generate embeddings for all edges
  await Promise.all([
    createEntityEdgeEmbeddings(embedder, resolvedEdges),
    createEntityEdgeEmbeddings(embedder, invalidatedEdges)
  ]);

  return [resolvedEdges, invalidatedEdges, newEdges];
}

// -------------------------------------------------------------------------
// resolveExtractedEdge()
// -------------------------------------------------------------------------

export async function resolveExtractedEdge(
  llmClient: LLMClient,
  extractedEdge: EntityEdge,
  relatedEdges: EntityEdge[],
  relatedEdgeScores: number[],
  existingEdges: EntityEdge[],
  episode: EpisodicNode,
  edgeTypeCandidates?: Record<string, EdgeTypeDefinition> | null,
  llmContext?: GenerateResponseContext,
  deprecationGateConfig?: DeprecationGateConfig,
  resolutionConfig?: GraphitiResolutionConfig,
  tracer?: Tracer
): Promise<[EntityEdge, EntityEdge[]]> {
  const scope = tracer?.startSpan('resolution.edge') ?? null;

  const finalize = (
    resolvedEdge: EntityEdge,
    invalidatedEdges: EntityEdge[],
    attributes: Record<string, unknown>
  ): [EntityEdge, EntityEdge[]] => {
    scope?.span.addAttributes({
      'resolution.kind': 'edge',
      'resolution.related.count': relatedEdges.length,
      'resolution.invalidation_candidate.count': existingEdges.length,
      'resolution.prefilter.enabled': resolutionConfig?.pre_filter_enabled ?? false,
      ...attributes
    });
    return [resolvedEdge, invalidatedEdges];
  };

  try {
    // No related or existing edges — extract attributes if applicable and return
    if (relatedEdges.length === 0 && existingEdges.length === 0) {
      if (edgeTypeCandidates?.[extractedEdge.name]?.fields) {
        const fields = edgeTypeCandidates[extractedEdge.name]!.fields!;
        if (Object.keys(fields).length > 0) {
          const attrs = await extractEdgeAttributes(llmClient, extractedEdge, episode, fields, llmContext);
          extractedEdge.attributes = attrs;
        }
      }
      return finalize(extractedEdge, [], {
        'resolution.prefilter.invalidated_count': 0,
        'resolution.prefilter.skipped': false,
        'resolution.llm.invoked': false
      });
    }

    // Fast path: exact match on fact text and endpoints
    const normalizedFact = normalizeStringExact(extractedEdge.fact);
    for (const edge of relatedEdges) {
      if (
        edge.source_node_uuid === extractedEdge.source_node_uuid &&
        edge.target_node_uuid === extractedEdge.target_node_uuid &&
        normalizeStringExact(edge.fact) === normalizedFact
      ) {
        const resolved = { ...edge };
        if (episode && !resolved.episodes?.includes(episode.uuid)) {
          resolved.episodes = [...(resolved.episodes ?? []), episode.uuid];
        }
        return finalize(resolved, [], {
          'resolution.prefilter.invalidated_count': 0,
          'resolution.prefilter.skipped': false,
          'resolution.llm.invoked': false,
          'resolution.exact_match': true
        });
      }
    }

    // --- Negation pre-filter: skip LLM for obvious contradictions ---
    const preFilterInvalidated: EntityEdge[] = [];
    const preFilterSkippedIndices = new Set<number>();
    const preFilterNow = utcNow();

    for (let i = 0; i < existingEdges.length; i++) {
      const existing = existingEdges[i]!;
      // Shared entities = node UUID overlap between new and existing edge
      const sharedEntities: string[] = [];
      if (extractedEdge.source_node_uuid === existing.source_node_uuid) sharedEntities.push('source');
      if (extractedEdge.target_node_uuid === existing.target_node_uuid) sharedEntities.push('target');
      if (extractedEdge.source_node_uuid === existing.target_node_uuid) sharedEntities.push('source-target');
      if (extractedEdge.target_node_uuid === existing.source_node_uuid) sharedEntities.push('target-source');

      const signal = detectNegation(extractedEdge.fact, existing.fact, sharedEntities);

      if (signal.confidence === 'high') {
        // Deterministic invalidation — skip LLM for this pair
        const invalidated = { ...existing };
        invalidated.invalid_at = extractedEdge.valid_at ?? preFilterNow;
        invalidated.expired_at = invalidated.expired_at ?? preFilterNow;
        preFilterInvalidated.push(invalidated);
        preFilterSkippedIndices.add(i);
      }
      // MEDIUM: leave in existingEdges for LLM to evaluate
      // NONE: leave in existingEdges, LLM may still find contradictions
    }

    // Remove pre-filtered edges from the LLM's invalidation candidate batch
    const filteredExistingEdges = existingEdges.filter((_, i) => !preFilterSkippedIndices.has(i));
    // --- End negation pre-filter ---

    if (shouldSkipEdgeResolution(relatedEdgeScores, resolutionConfig)) {
      if (resolutionConfig) {
        const top1 = relatedEdgeScores[0] ?? null;
        const top2 = relatedEdgeScores[1] ?? null;
        logResolutionDecision(resolutionConfig, '[graphiti-ts][resolution][edge]', {
          fact: extractedEdge.fact,
          top1_similarity: top1,
          top2_similarity: top2,
          margin: top1 !== null && top2 !== null ? top1 - top2 : null,
          skipped: true,
        });
      }

      if (edgeTypeCandidates?.[extractedEdge.name]?.fields) {
        const fields = edgeTypeCandidates[extractedEdge.name]!.fields!;
        if (Object.keys(fields).length > 0) {
          const attrs = await extractEdgeAttributes(llmClient, extractedEdge, episode, fields, llmContext);
          extractedEdge.attributes = attrs;
        }
      } else {
        extractedEdge.attributes = {};
      }

      return finalize(extractedEdge, preFilterInvalidated, {
        'resolution.prefilter.invalidated_count': preFilterInvalidated.length,
        'resolution.prefilter.skipped': true,
        'resolution.llm.invoked': false,
        'resolution.top1_similarity': relatedEdgeScores[0] ?? null,
        'resolution.top2_similarity': relatedEdgeScores[1] ?? null
      });
    }

    // Log non-skipped edge resolution decision
    if (resolutionConfig) {
      const top1 = relatedEdgeScores[0] ?? null;
      const top2 = relatedEdgeScores[1] ?? null;
      logResolutionDecision(resolutionConfig, '[graphiti-ts][resolution][edge]', {
        fact: extractedEdge.fact,
        top1_similarity: top1,
        top2_similarity: top2,
        margin: top1 !== null && top2 !== null ? top1 - top2 : null,
        skipped: false,
      });
    }

    // LLM resolution
    const relatedEdgesContext = relatedEdges.map((e, i) => ({ idx: i, fact: e.fact }));
    const invalidationIdxOffset = relatedEdges.length;
    const invalidationContext = filteredExistingEdges.map((e, i) => ({
      idx: invalidationIdxOffset + i,
      fact: e.fact
    }));

    const context = {
      existing_facts: JSON.stringify(relatedEdgesContext),
      invalidation_candidates: JSON.stringify(invalidationContext),
      new_fact: extractedEdge.fact
    };

    const llmResponse = await callGenerateResponse(llmClient,
      promptLibrary.dedupeEdges.resolveEdge(context),
      {
        response_model: {
          type: 'object',
          properties: {
            duplicate_facts: { type: 'array' },
            contradicted_facts: { type: 'array' }
          }
        },
        model_size: 'small',
        prompt_name: 'dedupe_edges.resolve_edge'
      },
      llmContext
    );

    const responseObject = llmResponse as unknown as EdgeDuplicate;
    const duplicateFacts = responseObject.duplicate_facts ?? [];
    const contradictedFacts = responseObject.contradicted_facts ?? [];

    // Validate and resolve duplicates
    const validDuplicateIds = duplicateFacts.filter(
      (i: number) => i >= 0 && i < relatedEdges.length
    );

    let resolvedEdge = extractedEdge;
    for (const duplicateId of validDuplicateIds) {
      resolvedEdge = { ...relatedEdges[duplicateId]! };
      break;
    }

    if (validDuplicateIds.length > 0 && episode) {
      resolvedEdge.episodes = [...(resolvedEdge.episodes ?? []), episode.uuid];
    }

    // Process contradictions
    const invalidationCandidates: EntityEdge[] = [];
    const maxValidIdx = relatedEdges.length + filteredExistingEdges.length - 1;

    for (const idx of contradictedFacts) {
      if (idx >= 0 && idx < relatedEdges.length) {
        invalidationCandidates.push(relatedEdges[idx]!);
      } else if (idx >= invalidationIdxOffset && idx <= maxValidIdx) {
        invalidationCandidates.push(filteredExistingEdges[idx - invalidationIdxOffset]!);
      }
    }

    // Extract structured attributes
    if (edgeTypeCandidates?.[resolvedEdge.name]?.fields) {
      const fields = edgeTypeCandidates[resolvedEdge.name]!.fields!;
      if (Object.keys(fields).length > 0) {
        const attrs = await extractEdgeAttributes(llmClient, resolvedEdge, episode, fields, llmContext);
        resolvedEdge.attributes = attrs;
      }
    } else {
      resolvedEdge.attributes = {};
    }

    // Handle edge expiration
    const now = utcNow();
    if (resolvedEdge.invalid_at && !resolvedEdge.expired_at) {
      resolvedEdge.expired_at = now;
    }

    // Determine contradictions
    const invalidatedEdges = resolveEdgeContradictions(
      resolvedEdge,
      invalidationCandidates,
      deprecationGateConfig
    );

    // Merge pre-filter invalidations with LLM-detected invalidations
    return finalize(resolvedEdge, [...preFilterInvalidated, ...invalidatedEdges], {
      'resolution.prefilter.invalidated_count': preFilterInvalidated.length,
      'resolution.prefilter.skipped': false,
      'resolution.llm.invoked': true,
      'resolution.top1_similarity': relatedEdgeScores[0] ?? null,
      'resolution.top2_similarity': relatedEdgeScores[1] ?? null,
      'resolution.invalidated.count': preFilterInvalidated.length + invalidatedEdges.length
    });
  } finally {
    scope?.close();
  }
}

export function shouldSkipEdgeResolution(
  scores: number[],
  config?: GraphitiResolutionConfig
): boolean {
  if (!config?.pre_filter_enabled) return false;
  if (scores.length < 2) return false;

  const top1 = scores[0] ?? Number.NEGATIVE_INFINITY;
  const top2 = scores[1] ?? Number.NEGATIVE_INFINITY;
  const threshold = config.edge_similarity_threshold ?? 0.65;
  const marginThreshold = config.margin_threshold ?? 0.05;
  const margin = top1 - top2;

  return top1 < threshold && margin < marginThreshold;
}

export function resolveEdgeContradictions(
  resolvedEdge: EntityEdge,
  invalidationCandidates: EntityEdge[],
  deprecationGateConfig?: DeprecationGateConfig
): EntityEdge[] {
  if (invalidationCandidates.length === 0) return [];

  const now = utcNow();
  const invalidatedEdges: EntityEdge[] = [];

  for (const edge of invalidationCandidates) {
    // Check temporal ordering
    if (
      edge.invalid_at &&
      resolvedEdge.valid_at &&
      edge.invalid_at <= resolvedEdge.valid_at
    ) {
      continue;
    }
    if (
      edge.valid_at &&
      resolvedEdge.invalid_at &&
      resolvedEdge.invalid_at <= edge.valid_at
    ) {
      continue;
    }

    // New edge invalidates old edge (temporal ordering)
    if (edge.valid_at && resolvedEdge.valid_at && edge.valid_at < resolvedEdge.valid_at) {
      // --- Death gate: evidence-weighted resolution ---
      const existingWeight = computeEvidenceWeight(edge);

      // Heuristic contradiction scoring (synchronous, no LLM)
      const scores: ContradictionScores = {
        contradiction_strength: heuristicContradictionStrength(resolvedEdge),
        source_authority: heuristicSourceAuthority(resolvedEdge),
        corroboration_count: heuristicCorroborationCount(resolvedEdge),
      };

      const resolution = resolveContradictionGate(
        edge,
        resolvedEdge,
        scores,
        existingWeight,
        deprecationGateConfig
      );

      if (resolution.action === 'keep_existing') continue;

      if (resolution.action === 'dispute_both') {
        // Don't invalidate — flag both sides as disputed
        const disputed = { ...edge };
        disputed.epistemic_status = 'disputed';
        disputed.disputed_by = [...(disputed.disputed_by ?? []), resolvedEdge.uuid];
        invalidatedEdges.push(disputed);

        // Mark the resolved (contradicting) edge as disputed too — symmetric
        resolvedEdge.epistemic_status = 'disputed';
        resolvedEdge.disputed_by = [...(resolvedEdge.disputed_by ?? []), edge.uuid];
        continue;
      }

      // deprecate_existing or replace — invalidate normally
      const invalidated = { ...edge };
      invalidated.invalid_at = resolvedEdge.valid_at;
      invalidated.expired_at = invalidated.expired_at ?? now;
      invalidated.epistemic_status = 'deprecated';
      invalidatedEdges.push(invalidated);
    }
  }

  return invalidatedEdges;
}

/** Map resolvedEdge properties to contradiction_strength score (1-5) */
function heuristicContradictionStrength(edge: EntityEdge): number {
  const preFilterConfidence = (edge.attributes as Record<string, unknown>)?.negation_confidence;
  if (preFilterConfidence === 'high') return 5;
  if (preFilterConfidence === 'medium') return 3;
  return 4; // LLM-detected contradiction: strong but not definitive
}

/** Map edge epistemic status to source_authority score (1-5) */
function heuristicSourceAuthority(edge: EntityEdge): number {
  switch (edge.epistemic_status) {
    case 'fact':
    case 'observation': return 5;
    case 'decision': return 4;
    case 'claim': return 3;
    case 'opinion':
    case 'preference': return 2;
    case 'hypothesis': return 1;
    default: return 3; // null/unknown defaults to moderate
  }
}

/** Map supported_by count to corroboration_count score (1-5) */
function heuristicCorroborationCount(edge: EntityEdge): number {
  const count = edge.supported_by?.length ?? 0;
  if (count >= 5) return 5;
  if (count >= 3) return 4;
  if (count >= 2) return 3;
  if (count >= 1) return 2;
  return 1;
}

async function extractEdgeAttributes(
  llmClient: LLMClient,
  edge: EntityEdge,
  episode: EpisodicNode,
  schema: Record<string, unknown>,
  llmContext?: GenerateResponseContext
): Promise<Record<string, unknown>> {
  const context = {
    fact: edge.fact,
    reference_time: (episode.valid_at ?? episode.created_at).toISOString(),
    existing_attributes: JSON.stringify(edge.attributes ?? {})
  };

  return callGenerateResponse(llmClient,
    promptLibrary.extractEdges.extractEdgeAttributes(context),
    {
      response_model: schema,
      model_size: 'small',
      prompt_name: 'extract_edges.extract_attributes'
    },
    llmContext
  );
}

// -------------------------------------------------------------------------
// Helper: get edges between two nodes
// -------------------------------------------------------------------------

async function getEdgesBetweenNodes(
  driver: import('../contracts').GraphDriver,
  sourceUuid: string,
  targetUuid: string
): Promise<EntityEdge[]> {
  const result = await driver.executeQuery<Record<string, unknown>>(
    `
    MATCH (source:Entity {uuid: $source_uuid})-[e:RELATES_TO]->(target:Entity {uuid: $target_uuid})
    RETURN
      ${ENTITY_EDGE_RETURN_FIELDS}
    `,
    { params: { source_uuid: sourceUuid, target_uuid: targetUuid }, routing: 'r' }
  );

  return result.records.map((r) => ({
    uuid: r.uuid as string,
    group_id: (r.group_id as string) ?? '',
    source_node_uuid: r.source_node_uuid as string,
    target_node_uuid: r.target_node_uuid as string,
    created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
    name: (r.name as string) ?? '',
    fact: (r.fact as string) ?? '',
    fact_embedding: r.fact_embedding as number[] | null,
    episodes: (r.episodes as string[]) ?? [],
    expired_at: r.expired_at ? new Date(r.expired_at as string) : null,
    valid_at: r.valid_at ? new Date(r.valid_at as string) : null,
    invalid_at: r.invalid_at ? new Date(r.invalid_at as string) : null,
    confidence: Array.isArray(r.confidence) && (r.confidence as number[]).length === 3
      ? (r.confidence as [number, number, number])
      : null,
    epistemic_status: (r.epistemic_status as EntityEdge['epistemic_status']) ?? null,
    supported_by: (r.supported_by as string[]) ?? null,
    supports: (r.supports as string[]) ?? null,
    disputed_by: (r.disputed_by as string[]) ?? null,
    epistemic_history: (() => {
      const raw = r.epistemic_history;
      if (!raw) return null;
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    })(),
    birth_score: (() => {
      const raw = r.birth_score;
      if (!raw) return null;
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    })(),
  }));
}

// -------------------------------------------------------------------------
// Helper: create embeddings for entity edges
// -------------------------------------------------------------------------

async function createEntityEdgeEmbeddings(
  embedder: EmbedderClient,
  edges: EntityEdge[]
): Promise<void> {
  const tasks = edges
    .filter((edge) => !edge.fact_embedding)
    .map((edge) => async () => {
      edge.fact_embedding = await embedder.create([edge.fact.replaceAll('\n', ' ')]);
    });

  if (tasks.length > 0) {
    await semaphoreGather(tasks);
  }
}
