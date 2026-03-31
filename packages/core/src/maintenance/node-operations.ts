/**
 * Node extraction and resolution — port of Python's utils/maintenance/node_operations.py.
 *
 * Core functions:
 * - extractNodes(): Extract entity nodes from an episode via LLM
 * - resolveExtractedNodes(): Resolve extracted nodes against existing graph (similarity + LLM dedup)
 * - extractAttributesFromNodes(): Extract attributes and summaries for resolved nodes
 */

import { utcNow } from '@graphiti/shared';

import type { GraphitiClients, LLMClient, GenerateResponseOptions } from '../contracts';
import { generateResponse as defaultGenerateResponse, type GenerateResponseContext } from '../llm/generate-response';
import type { EntityEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode, EpisodeType } from '../domain/nodes';
import { EpisodeTypes } from '../domain/nodes';
import { promptLibrary } from '../prompts/lib';
import type {
  ExtractedEntities,
  ExtractedEntity,
  NodeDuplicate,
  NodeResolutions,
  SummarizedEntities
} from '../prompts/models';
import type { SearchResults } from '../search/config';
import { search } from '../search/search';
import { createSearchFilters } from '../search/filters';
import { NODE_HYBRID_SEARCH_RRF } from '../search/recipes';
import {
  buildCandidateIndexes,
  normalizeStringExact,
  resolveWithSimilarity,
  type DedupCandidateIndexes,
  type DedupResolutionState
} from '../dedup/dedup-helpers';
import { semaphoreGather } from '../utils/concurrency';
import { truncateAtSentence, MAX_SUMMARY_CHARS } from '../utils/text';

const MAX_NODES = 30;

/** Build a GenerateResponseContext from GraphitiClients. */
function buildContext(clients: GraphitiClients): GenerateResponseContext {
  return {
    tokenTracker: clients.tokenTracker ?? null,
    cache: clients.cache ?? null
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
// Entity type context builder
// -------------------------------------------------------------------------

export interface EntityTypeDefinition {
  description?: string;
  fields?: Record<string, unknown>;
}

export function buildEntityTypesContext(
  entityTypes?: Record<string, EntityTypeDefinition> | null
): Array<{ entity_type_id: number; entity_type_name: string; entity_type_description: string }> {
  const context: Array<{
    entity_type_id: number;
    entity_type_name: string;
    entity_type_description: string;
  }> = [
    {
      entity_type_id: 0,
      entity_type_name: 'Entity',
      entity_type_description:
        'Default entity classification. Use this entity type if the entity is not one of the other listed types.'
    }
  ];

  if (entityTypes) {
    let id = 1;
    for (const [typeName, typeDef] of Object.entries(entityTypes)) {
      context.push({
        entity_type_id: id++,
        entity_type_name: typeName,
        entity_type_description: typeDef.description ?? `Entity type: ${typeName}`
      });
    }
  }

  return context;
}

// -------------------------------------------------------------------------
// extractNodes()
// -------------------------------------------------------------------------

export async function extractNodes(
  clients: GraphitiClients,
  episode: EpisodicNode,
  previousEpisodes: EpisodicNode[],
  entityTypes?: Record<string, EntityTypeDefinition> | null,
  excludedEntityTypes?: string[] | null,
  customExtractionInstructions?: string | null
): Promise<EntityNode[]> {
  const llmClient = clients.llm_client;
  const entityTypesContext = buildEntityTypesContext(entityTypes);

  const context: Record<string, unknown> = {
    episode_content: episode.content,
    episode_timestamp: (episode.valid_at ?? episode.created_at).toISOString(),
    previous_episodes: previousEpisodes.map((ep) => ep.content),
    custom_extraction_instructions: customExtractionInstructions ?? '',
    entity_types: JSON.stringify(entityTypesContext, null, 2),
    source_description: episode.source_description,
    // For backward compat with existing prompt templates:
    current_message: episode.content,
    previous_messages: previousEpisodes.map((ep) => ep.content).join('\n'),
    content: episode.content
  };

  // Choose prompt based on episode source type
  let prompt;
  let promptName: string;
  if (episode.source === EpisodeTypes.message) {
    prompt = promptLibrary.extractNodes.extractMessage(context);
    promptName = 'extract_nodes.extract_message';
  } else if (episode.source === EpisodeTypes.json) {
    prompt = promptLibrary.extractNodes.extractJson(context);
    promptName = 'extract_nodes.extract_json';
  } else {
    prompt = promptLibrary.extractNodes.extractText(context);
    promptName = 'extract_nodes.extract_text';
  }

  const llmResponse = await callGenerateResponse(llmClient, prompt, {
    response_model: { type: 'object', properties: { extracted_entities: { type: 'array' } } },
    group_id: episode.group_id,
    prompt_name: promptName
  }, buildContext(clients));

  const extractedEntities = (llmResponse as unknown as ExtractedEntities).extracted_entities ?? [];

  // Filter empty names
  const filteredEntities = extractedEntities.filter(
    (e: ExtractedEntity) => e.name && e.name.trim() !== ''
  );

  // Convert to EntityNode objects
  return createEntityNodes(filteredEntities, entityTypesContext, excludedEntityTypes, episode);
}

function createEntityNodes(
  extractedEntities: ExtractedEntity[],
  entityTypesContext: Array<{
    entity_type_id: number;
    entity_type_name: string;
    entity_type_description: string;
  }>,
  excludedEntityTypes: string[] | null | undefined,
  episode: EpisodicNode
): EntityNode[] {
  const nodes: EntityNode[] = [];
  const now = utcNow();

  for (const extracted of extractedEntities) {
    const typeId = extracted.entity_type_id;
    let entityTypeName = 'Entity';
    if (typeId >= 0 && typeId < entityTypesContext.length) {
      entityTypeName = entityTypesContext[typeId]?.entity_type_name ?? 'Entity';
    }

    // Skip excluded types
    if (excludedEntityTypes?.includes(entityTypeName)) {
      continue;
    }

    const labels = [...new Set(['Entity', entityTypeName])];

    nodes.push({
      uuid: crypto.randomUUID(),
      name: extracted.name,
      group_id: episode.group_id,
      labels,
      summary: '',
      created_at: now
    });
  }

  return nodes;
}

// -------------------------------------------------------------------------
// resolveExtractedNodes()
// -------------------------------------------------------------------------

export async function resolveExtractedNodes(
  clients: GraphitiClients,
  extractedNodes: EntityNode[],
  episode?: EpisodicNode | null,
  previousEpisodes?: EpisodicNode[] | null,
  entityTypes?: Record<string, EntityTypeDefinition> | null,
  existingNodesOverride?: EntityNode[] | null
): Promise<[EntityNode[], Record<string, string>, Array<[EntityNode, EntityNode]>]> {
  if (extractedNodes.length === 0) {
    return [[], {}, []];
  }

  const llmClient = clients.llm_client;

  // Collect candidate nodes from search
  const existingNodes = await collectCandidateNodes(
    clients,
    extractedNodes,
    existingNodesOverride ?? null
  );

  const indexes = buildCandidateIndexes(existingNodes);
  const state: DedupResolutionState = {
    resolvedNodes: new Array(extractedNodes.length).fill(null),
    uuidMap: new Map(),
    unresolvedIndices: [],
    duplicatePairs: []
  };

  // Phase 1: Resolve with string similarity
  resolveWithSimilarity(extractedNodes, indexes, state);

  // Phase 2: Escalate unresolved to LLM
  await resolveWithLlm(
    llmClient,
    extractedNodes,
    indexes,
    state,
    episode ?? null,
    previousEpisodes ?? null,
    entityTypes ?? null,
    buildContext(clients)
  );

  // Fill in any remaining unresolved nodes
  for (let idx = 0; idx < extractedNodes.length; idx++) {
    if (state.resolvedNodes[idx] === null) {
      state.resolvedNodes[idx] = extractedNodes[idx]!;
      state.uuidMap.set(extractedNodes[idx]!.uuid, extractedNodes[idx]!.uuid);
    }
  }

  const resolvedNodes = state.resolvedNodes.filter((n): n is EntityNode => n !== null);
  const uuidMap: Record<string, string> = Object.fromEntries(state.uuidMap);
  const duplicatePairs: Array<[EntityNode, EntityNode]> = state.duplicatePairs as Array<
    [EntityNode, EntityNode]
  >;

  return [resolvedNodes, uuidMap, duplicatePairs];
}

async function collectCandidateNodes(
  clients: GraphitiClients,
  extractedNodes: EntityNode[],
  existingNodesOverride: EntityNode[] | null
): Promise<EntityNode[]> {
  // Search for existing nodes matching each extracted node name
  const searchResults: SearchResults[] = await semaphoreGather(
    extractedNodes.map(
      (node) => () =>
        search(
          clients.driver,
          node.name,
          [node.group_id],
          NODE_HYBRID_SEARCH_RRF,
          createSearchFilters()
        )
    )
  );

  const candidateNodes: EntityNode[] = searchResults.flatMap((result) => result.nodes);

  if (existingNodesOverride) {
    candidateNodes.push(...existingNodesOverride);
  }

  // Deduplicate by UUID
  const seen = new Set<string>();
  return candidateNodes.filter((node) => {
    if (seen.has(node.uuid)) return false;
    seen.add(node.uuid);
    return true;
  });
}

async function resolveWithLlm(
  llmClient: LLMClient,
  extractedNodes: EntityNode[],
  indexes: DedupCandidateIndexes,
  state: DedupResolutionState,
  episode: EpisodicNode | null,
  previousEpisodes: EpisodicNode[] | null,
  entityTypes: Record<string, EntityTypeDefinition> | null,
  llmContext?: GenerateResponseContext
): Promise<void> {
  if (state.unresolvedIndices.length === 0) return;

  const llmExtractedNodes = state.unresolvedIndices.map((i) => extractedNodes[i]!);

  const extractedNodesContext = llmExtractedNodes.map((node, i) => ({
    id: i,
    name: node.name,
    entity_type: node.labels,
    entity_type_description:
      entityTypes?.[node.labels.find((l) => l !== 'Entity') ?? '']?.description ??
      'Default Entity Type'
  }));

  const existingNodesContext = indexes.existingNodes.map((candidate) => ({
    name: candidate.name,
    entity_types: candidate.labels,
    ...(candidate.attributes ?? {})
  }));

  // Build name -> node mapping
  const existingNodesByName = new Map<string, EntityNode>();
  for (const node of indexes.existingNodes) {
    existingNodesByName.set(node.name, node);
  }

  const context = {
    entities: JSON.stringify(extractedNodesContext),
    existing_entities: JSON.stringify(existingNodesContext),
    current_message: episode?.content ?? '',
    previous_messages: previousEpisodes?.map((ep) => ep.content).join('\n') ?? ''
  };

  const llmResponse = await callGenerateResponse(llmClient,
    promptLibrary.dedupeNodes.dedupeNodes(context),
    {
      response_model: {
        type: 'object',
        properties: { entity_resolutions: { type: 'array' } }
      },
      prompt_name: 'dedupe_nodes.nodes'
    },
    llmContext
  );

  const nodeResolutions: NodeDuplicate[] =
    (llmResponse as unknown as NodeResolutions).entity_resolutions ?? [];

  const processedRelativeIds = new Set<number>();

  for (const resolution of nodeResolutions) {
    const relativeId = resolution.id;
    const duplicateName = resolution.duplicate_name;

    if (relativeId < 0 || relativeId >= state.unresolvedIndices.length) continue;
    if (processedRelativeIds.has(relativeId)) continue;
    processedRelativeIds.add(relativeId);

    const originalIndex = state.unresolvedIndices[relativeId]!;
    const extractedNode = extractedNodes[originalIndex]!;

    let resolvedNode: EntityNode;
    if (!duplicateName) {
      resolvedNode = extractedNode;
    } else if (existingNodesByName.has(duplicateName)) {
      resolvedNode = existingNodesByName.get(duplicateName)!;
    } else {
      // Invalid duplicate name — treat as no duplicate
      resolvedNode = extractedNode;
    }

    state.resolvedNodes[originalIndex] = resolvedNode;
    state.uuidMap.set(extractedNode.uuid, resolvedNode.uuid);
    if (resolvedNode.uuid !== extractedNode.uuid) {
      state.duplicatePairs.push([extractedNode, resolvedNode]);
    }
  }
}

// -------------------------------------------------------------------------
// extractAttributesFromNodes()
// -------------------------------------------------------------------------

export async function extractAttributesFromNodes(
  clients: GraphitiClients,
  nodes: EntityNode[],
  episode?: EpisodicNode | null,
  previousEpisodes?: EpisodicNode[] | null,
  entityTypes?: Record<string, EntityTypeDefinition> | null,
  edges?: EntityEdge[] | null
): Promise<EntityNode[]> {
  const llmClient = clients.llm_client;
  const embedder = clients.embedder;

  // Build edges-by-node lookup
  const edgesByNode = new Map<string, EntityEdge[]>();
  if (edges) {
    for (const edge of edges) {
      if (!edgesByNode.has(edge.source_node_uuid)) {
        edgesByNode.set(edge.source_node_uuid, []);
      }
      if (!edgesByNode.has(edge.target_node_uuid)) {
        edgesByNode.set(edge.target_node_uuid, []);
      }
      edgesByNode.get(edge.source_node_uuid)!.push(edge);
      edgesByNode.get(edge.target_node_uuid)!.push(edge);
    }
  }

  // Extract attributes in parallel (per-entity calls)
  const ctx = buildContext(clients);
  const attributeResults = await semaphoreGather(
    nodes.map(
      (node) => () =>
        extractEntityAttributes(
          llmClient,
          node,
          episode ?? null,
          previousEpisodes ?? null,
          entityTypes?.[node.labels.find((l) => l !== 'Entity') ?? ''] ?? null,
          ctx
        )
    )
  );

  // Apply attributes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const attrs = attributeResults[i];
    if (attrs && Object.keys(attrs).length > 0) {
      node.attributes = { ...(node.attributes ?? {}), ...attrs } as import('../domain/common').EntityAttributes;
    }
  }

  // Extract summaries in batch
  await extractEntitySummariesBatch(
    llmClient,
    nodes,
    episode ?? null,
    previousEpisodes ?? null,
    edgesByNode,
    ctx
  );

  // Generate embeddings
  if (embedder) {
    await semaphoreGather(
      nodes
        .filter((node) => !node.name_embedding)
        .map((node) => async () => {
          node.name_embedding = await embedder.create([node.name.replaceAll('\n', ' ')]);
        })
    );
  }

  return nodes;
}

async function extractEntityAttributes(
  llmClient: LLMClient,
  node: EntityNode,
  episode: EpisodicNode | null,
  previousEpisodes: EpisodicNode[] | null,
  entityType: EntityTypeDefinition | null,
  llmContext?: GenerateResponseContext
): Promise<Record<string, unknown>> {
  if (!entityType || !entityType.fields || Object.keys(entityType.fields).length === 0) {
    return {};
  }

  const context = {
    node: {
      name: node.name,
      entity_types: node.labels,
      attributes: node.attributes ?? {}
    },
    episode_content: episode?.content ?? '',
    previous_episodes: previousEpisodes?.map((ep) => ep.content) ?? []
  };

  const llmResponse = await callGenerateResponse(llmClient,
    promptLibrary.extractNodes.extractAttributes(context),
    {
      response_model: entityType.fields as Record<string, unknown>,
      model_size: 'small',
      group_id: node.group_id,
      prompt_name: 'extract_nodes.extract_attributes'
    },
    llmContext
  );

  return llmResponse;
}

async function extractEntitySummariesBatch(
  llmClient: LLMClient,
  nodes: EntityNode[],
  episode: EpisodicNode | null,
  previousEpisodes: EpisodicNode[] | null,
  edgesByNode: Map<string, EntityEdge[]>,
  llmContext?: GenerateResponseContext
): Promise<void> {
  const nodesNeedingLlm: EntityNode[] = [];

  for (const node of nodes) {
    const nodeEdges = edgesByNode.get(node.uuid) ?? [];

    // Build summary with edge facts appended
    let summaryWithEdges = node.summary;
    if (nodeEdges.length > 0) {
      const edgeFacts = nodeEdges
        .map((e) => e.fact)
        .filter(Boolean)
        .join('\n');
      summaryWithEdges = `${summaryWithEdges}\n${edgeFacts}`.trim();
    }

    // If summary is short enough, use it directly
    if (summaryWithEdges && summaryWithEdges.length <= MAX_SUMMARY_CHARS * 4) {
      node.summary = summaryWithEdges;
      continue;
    }

    if (!summaryWithEdges && !episode) continue;

    nodesNeedingLlm.push(node);
  }

  if (nodesNeedingLlm.length === 0) return;

  // Partition into flights
  const flights: EntityNode[][] = [];
  for (let i = 0; i < nodesNeedingLlm.length; i += MAX_NODES) {
    flights.push(nodesNeedingLlm.slice(i, i + MAX_NODES));
  }

  await semaphoreGather(
    flights.map(
      (flight) => () => processSummaryFlight(llmClient, flight, episode, previousEpisodes, llmContext)
    )
  );
}

async function processSummaryFlight(
  llmClient: LLMClient,
  nodes: EntityNode[],
  episode: EpisodicNode | null,
  previousEpisodes: EpisodicNode[] | null,
  llmContext?: GenerateResponseContext
): Promise<void> {
  const entitiesContext = nodes.map((node) => ({
    name: node.name,
    summary: node.summary,
    entity_types: node.labels,
    attributes: node.attributes ?? {}
  }));

  const batchContext = {
    entities: JSON.stringify(entitiesContext),
    episode_content: episode?.content ?? '',
    previous_episodes: previousEpisodes?.map((ep) => ep.content) ?? []
  };

  const groupId = nodes[0]?.group_id ?? null;

  const llmResponse = await callGenerateResponse(llmClient,
    promptLibrary.extractNodes.extractSummariesBatch(batchContext),
    {
      response_model: { type: 'object', properties: { summaries: { type: 'array' } } },
      model_size: 'small',
      group_id: groupId,
      prompt_name: 'extract_nodes.extract_summaries_batch'
    },
    llmContext
  );

  // Build name lookup
  const nameToNodes = new Map<string, EntityNode[]>();
  for (const node of nodes) {
    const key = node.name.toLowerCase();
    if (!nameToNodes.has(key)) nameToNodes.set(key, []);
    nameToNodes.get(key)!.push(node);
  }

  const summariesResponse = llmResponse as unknown as SummarizedEntities;
  if (summariesResponse.summaries) {
    for (const summarized of summariesResponse.summaries) {
      const matchingNodes = nameToNodes.get(summarized.name.toLowerCase());
      if (matchingNodes) {
        const truncatedSummary = truncateAtSentence(summarized.summary, MAX_SUMMARY_CHARS);
        for (const node of matchingNodes) {
          node.summary = truncatedSummary;
        }
      }
    }
  }
}
