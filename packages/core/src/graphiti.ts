import { SearchRerankerError, utcNow } from '@graphiti/shared';

import { createCommunityNamespace, type CommunityNamespaceApi } from './namespaces/communities';
import { createEdgeNamespace, type EdgeNamespaceApi } from './namespaces/edges';
import { createNodeNamespace, type NodeNamespaceApi } from './namespaces/nodes';
import { createTracer, NoOpTracer, type Tracer } from './tracing';
import { TokenUsageTracker } from './llm/token-tracker';
import { LLMCache } from './llm/cache';
import type {
  CrossEncoderClient,
  EmbedderClient,
  GraphDriver,
  GraphitiClients,
  LLMClient
} from './contracts';
import { OpenAIClient } from './providers/llm/openai-client';
import { OpenAIEmbedder } from './providers/embedder/openai-embedder';
import { OpenAIRerankerClient } from './providers/reranker/openai-reranker';
import type { CommunityEdge, EntityEdge, EpisodicEdge, HasEpisodeEdge, NextEpisodeEdge } from './domain/edges';
import type { CommunityNode, EntityNode, EpisodicNode, SagaNode } from './domain/nodes';
import type { EpisodeType } from './domain/nodes';
import { EpisodeTypes } from './domain/nodes';
import {
  HeuristicEpisodeExtractor,
  ModelEpisodeExtractor,
  type EpisodeExtractor,
  type EpisodeExtractionResult
} from './ingest/extractor';
import {
  HeuristicNodeHydrator,
  ModelNodeHydrator,
  type NodeHydrator
} from './ingest/hydrator';
import { resolveEpisodeExtraction } from './ingest/resolver';
import {
  normalizeStringExact,
  buildCandidateIndexes,
  resolveWithSimilarity,
  type DedupResolutionState
} from './dedup/dedup-helpers';
import { buildDirectedUuidMap } from './dedup/union-find';
import {
  buildCommunities as buildCommunitiesOp,
  removeCommunities,
  updateCommunity as updateCommunityOp
} from './community/community-operations';
import type { SearchConfig, SearchResults } from './search/config';
import { EdgeRerankers, NodeRerankers, createSearchConfig } from './search/config';
import { createSearchFilters, type SearchFilters } from './search/filters';
import { EDGE_HYBRID_SEARCH_NODE_DISTANCE, EDGE_HYBRID_SEARCH_RRF } from './search/recipes';
import { search } from './search/search';
import { semaphoreGather } from './utils/concurrency';
import { needsMultiGroupRouting, executeWithMultiGroupRouting } from './utils/multi-group';
import { FalkorDriver } from './driver/falkordb-driver';
import { captureEvent } from './telemetry';
import {
  extractNodes,
  resolveExtractedNodes,
  extractAttributesFromNodes,
  type EntityTypeDefinition
} from './maintenance/node-operations';
import {
  extractEdges,
  resolveExtractedEdges,
  resolveExtractedEdge,
  buildEpisodicEdges,
  resolveEdgePointers,
  type EdgeTypeDefinition
} from './maintenance/edge-operations';
import {
  addNodesAndEdgesBulk,
  extractNodesAndEdgesBulk,
  dedupeNodesBulk,
  dedupeEdgesBulk,
  type RawEpisode
} from './maintenance/bulk-utils';

export interface GraphitiOptions {
  driver: GraphDriver;
  llm_client?: LLMClient | null;
  embedder?: EmbedderClient | null;
  cross_encoder?: CrossEncoderClient | null;
  episode_extractor?: EpisodeExtractor | null;
  node_hydrator?: NodeHydrator | null;
  tracer?: Tracer | null;
  /** Whether to store raw episode content. Defaults to true. */
  store_raw_episode_content?: boolean;
  /** Maximum number of concurrent operations. Defaults to 20. */
  max_coroutines?: number;
  /** Enable LLM response caching. Defaults to false. */
  cache_enabled?: boolean;
}

export interface AddTripletInput {
  source: EntityNode;
  edge: EntityEdge;
  target: EntityNode;
}

export interface AddTripletResult {
  nodes: [EntityNode, EntityNode];
  edges: [EntityEdge];
}

export interface AddEpisodeInput {
  episode: EpisodicNode;
  entities?: EntityNode[];
  entity_edges?: EntityEdge[];
}

export interface AddEpisodeResult {
  episode: EpisodicNode;
  episodic_edges: EpisodicEdge[];
  nodes: EntityNode[];
  edges: EntityEdge[];
  communities: CommunityNode[];
  community_edges: CommunityEdge[];
}

export interface AddBulkEpisodeResults {
  episodes: EpisodicNode[];
  episodic_edges: EpisodicEdge[];
  nodes: EntityNode[];
  edges: EntityEdge[];
  communities: CommunityNode[];
  community_edges: CommunityEdge[];
}

export interface IngestEpisodeInput {
  episode: EpisodicNode;
  previous_episode_count?: number;
  update_communities?: boolean;
  extraction_instructions?: string;
}

export interface IngestEpisodeResult {
  episode: EpisodicNode;
  episodic_edges: EpisodicEdge[];
  nodes: EntityNode[];
  edges: EntityEdge[];
  communities: CommunityNode[];
  community_edges: CommunityEdge[];
  previous_episodes: EpisodicNode[];
  extraction: EpisodeExtractionResult;
}

export interface IngestEpisodesInput {
  episodes: IngestEpisodeInput[];
}

export interface IngestEpisodesResult {
  episodes: IngestEpisodeResult[];
}

/**
 * Input for the Python-parity add_episode() method.
 * This is the primary ingestion API matching Python's full parameter set.
 */
export interface AddEpisodeFullInput {
  name: string;
  episode_body: string;
  source_description: string;
  reference_time: Date;
  source?: EpisodeType;
  group_id?: string | null;
  uuid?: string | null;
  update_communities?: boolean;
  entity_types?: Record<string, EntityTypeDefinition> | null;
  excluded_entity_types?: string[] | null;
  edge_types?: Record<string, EdgeTypeDefinition> | null;
  edge_type_map?: Record<string, string[]> | null;
  custom_extraction_instructions?: string | null;
  previous_episode_uuids?: string[] | null;
  saga?: string | SagaNode | null;
  saga_previous_episode_uuid?: string | null;
}

/**
 * Input for the Python-parity add_episode_bulk() method.
 */
export interface AddEpisodeBulkInput {
  bulk_episodes: RawEpisode[];
  group_id?: string | null;
  entity_types?: Record<string, EntityTypeDefinition> | null;
  excluded_entity_types?: string[] | null;
  edge_types?: Record<string, EdgeTypeDefinition> | null;
  edge_type_map?: Record<string, string[]> | null;
  custom_extraction_instructions?: string | null;
  saga?: string | SagaNode | null;
}

export { type RawEpisode } from './maintenance/bulk-utils';
export { type EntityTypeDefinition } from './maintenance/node-operations';
export { type EdgeTypeDefinition } from './maintenance/edge-operations';

export interface GraphitiSearchOptions {
  group_ids?: string[] | null;
  search_filter?: SearchFilters;
  bfs_origin_node_uuids?: string[] | null;
  center_node_uuid?: string | null;
}

export class Graphiti {
  driver: GraphDriver;
  readonly llm_client: LLMClient | null;
  readonly embedder: EmbedderClient | null;
  readonly cross_encoder: CrossEncoderClient | null;
  readonly tracer: Tracer;
  readonly episode_extractor: EpisodeExtractor;
  readonly node_hydrator: NodeHydrator;
  clients: GraphitiClients | null;
  readonly nodes: NodeNamespaceApi;
  readonly edges: EdgeNamespaceApi;
  readonly communities: CommunityNamespaceApi;
  readonly tokenTracker: TokenUsageTracker;
  readonly llmCache: LLMCache | null;
  readonly store_raw_episode_content: boolean;
  readonly max_coroutines: number | null;

  constructor(options: GraphitiOptions) {
    this.driver = options.driver;
    this.llm_client =
      options.llm_client === undefined ? createDefaultLLMClient() : options.llm_client;
    this.embedder =
      options.embedder === undefined ? createDefaultEmbedder() : options.embedder;
    this.cross_encoder =
      options.cross_encoder === undefined ? createDefaultReranker() : options.cross_encoder;
    this.episode_extractor =
      options.episode_extractor ??
      (this.llm_client
        ? new ModelEpisodeExtractor(this.llm_client, new HeuristicEpisodeExtractor())
        : new HeuristicEpisodeExtractor());
    this.node_hydrator =
      options.node_hydrator ??
      (this.llm_client
        ? new ModelNodeHydrator(this.llm_client, new HeuristicNodeHydrator())
        : new HeuristicNodeHydrator());
    this.tracer = createTracer(options.tracer ?? new NoOpTracer());
    this.nodes = createNodeNamespace(this.driver, this.embedder);
    this.edges = createEdgeNamespace(this.driver, this.embedder);
    this.communities = createCommunityNamespace(this.driver, this.embedder);
    this.tokenTracker = new TokenUsageTracker();
    this.llmCache = options.cache_enabled ? new LLMCache() : null;
    this.store_raw_episode_content = options.store_raw_episode_content ?? true;
    this.max_coroutines = options.max_coroutines ?? null;
    this.clients =
      this.llm_client && this.embedder && this.cross_encoder
        ? {
            driver: this.driver,
            llm_client: this.llm_client,
            embedder: this.embedder,
            cross_encoder: this.cross_encoder,
            tracer: this.tracer,
            tokenTracker: this.tokenTracker,
            cache: this.llmCache
          }
        : null;

    if (this.llm_client) {
      this.llm_client.setTracer(this.tracer);
    }

    // Capture initialization telemetry
    this._captureInitializationTelemetry();
  }

  private _captureInitializationTelemetry(): void {
    try {
      const getProviderType = (client: unknown): string => {
        if (!client) return 'none';
        const name = (client as { constructor: { name: string } }).constructor.name.toLowerCase();
        if (name.includes('openai')) return 'openai';
        if (name.includes('anthropic')) return 'anthropic';
        if (name.includes('gemini')) return 'gemini';
        if (name.includes('groq')) return 'groq';
        if (name.includes('azure')) return 'azure';
        if (name.includes('neo4j')) return 'neo4j';
        if (name.includes('falkor')) return 'falkordb';
        if (name.includes('voyage')) return 'voyage';
        return 'unknown';
      };

      captureEvent('graphiti_initialized', {
        llm_provider: getProviderType(this.llm_client),
        embedder_provider: getProviderType(this.embedder),
        reranker_provider: getProviderType(this.cross_encoder),
        database_provider: getProviderType(this.driver)
      });
    } catch {
      // Silently handle telemetry errors
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async buildIndicesAndConstraints(deleteExisting = false): Promise<void> {
    await this.driver.buildIndicesAndConstraints(deleteExisting);
  }

  async addTriplet(input: AddTripletInput): Promise<AddTripletResult> {
    const transaction = await this.driver.transaction();

    try {
      await this.nodes.entity.save(input.source);
      await this.nodes.entity.save(input.target);
      await this.edges.entity.save(input.edge);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    return {
      nodes: [input.source, input.target],
      edges: [input.edge]
    };
  }

  async addEpisode(input: AddEpisodeInput): Promise<AddEpisodeResult> {
    const transaction = await this.driver.transaction();
    const entities = input.entities ?? [];
    const edges = input.entity_edges ?? [];
    const episodicEdges: EpisodicEdge[] = [];

    try {
      for (const entity of entities) {
        await this.nodes.entity.save(entity);
      }

      await this.nodes.episode.save(input.episode);

      for (const edge of edges) {
        await this.edges.entity.save(edge);
      }

      for (const entity of entities) {
        const episodicEdge: EpisodicEdge = {
          uuid: `${input.episode.uuid}:${entity.uuid}`,
          group_id: input.episode.group_id,
          source_node_uuid: input.episode.uuid,
          target_node_uuid: entity.uuid,
          created_at: input.episode.created_at
        };
        await this.edges.episodic.save(episodicEdge);
        episodicEdges.push(episodicEdge);
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    return {
      episode: input.episode,
      episodic_edges: episodicEdges,
      nodes: entities,
      edges,
      communities: [],
      community_edges: []
    };
  }

  async ingestEpisode(input: IngestEpisodeInput): Promise<IngestEpisodeResult> {
    const referenceTime = input.episode.valid_at ?? input.episode.created_at;
    const previousEpisodes = await this.retrieveEpisodes(
      [input.episode.group_id],
      input.previous_episode_count ?? 5,
      referenceTime
    );
    const extraction = await this.episode_extractor.extract({
      episode: input.episode,
      previous_episodes: previousEpisodes.filter(
        (episode) => episode.uuid !== input.episode.uuid
      )
    });
    await this.enrichExtractionEmbeddings(extraction);
    const resolvedExtraction = await resolveEpisodeExtraction(
      this.driver,
      input.episode,
      extraction
    );
    const hydratedEntities = await this.node_hydrator.hydrate({
      episode: input.episode,
      previous_episodes: previousEpisodes,
      entities: resolvedExtraction.entities,
      entity_edges: [...resolvedExtraction.entity_edges, ...resolvedExtraction.invalidated_edges]
    });
    input.episode.entity_edges = [
      ...resolvedExtraction.entity_edges.map((edge) => edge.uuid),
      ...resolvedExtraction.invalidated_edges.map((edge) => edge.uuid)
    ];
    const result = await this.addEpisode({
      episode: input.episode,
      entities: hydratedEntities,
      entity_edges: [...resolvedExtraction.entity_edges, ...resolvedExtraction.invalidated_edges]
    });

    // Optionally rebuild communities after ingest
    if (input.update_communities && this.llm_client) {
      const communityResult = await this.buildCommunities([input.episode.group_id]);
      result.communities = communityResult.nodes;
      result.community_edges = communityResult.edges;
    }

    return {
      ...result,
      previous_episodes: previousEpisodes,
      extraction: {
        entities: hydratedEntities,
        entity_edges: [...resolvedExtraction.entity_edges, ...resolvedExtraction.invalidated_edges]
      }
    };
  }

  async ingestEpisodes(input: IngestEpisodesInput): Promise<IngestEpisodesResult> {
    const orderedEpisodes = [...input.episodes].sort((left, right) => {
      const leftTime = left.episode.valid_at ?? left.episode.created_at;
      const rightTime = right.episode.valid_at ?? right.episode.created_at;
      const timeDifference = leftTime.getTime() - rightTime.getTime();

      if (timeDifference !== 0) {
        return timeDifference;
      }

      return left.episode.uuid.localeCompare(right.episode.uuid);
    });
    const results: IngestEpisodeResult[] = [];

    for (const episodeInput of orderedEpisodes) {
      results.push(await this.ingestEpisode(episodeInput));
    }

    return {
      episodes: results
    };
  }

  async addEpisodeBulk(
    inputs: IngestEpisodeInput[]
  ): Promise<IngestEpisodesResult> {
    if (inputs.length === 0) {
      return { episodes: [] };
    }

    const orderedInputs = [...inputs].sort((left, right) => {
      const leftTime = left.episode.valid_at ?? left.episode.created_at;
      const rightTime = right.episode.valid_at ?? right.episode.created_at;
      const timeDifference = leftTime.getTime() - rightTime.getTime();
      return timeDifference !== 0 ? timeDifference : left.episode.uuid.localeCompare(right.episode.uuid);
    });

    // Phase 1: Parallel extraction across all episodes
    const extractionResults = await Promise.all(
      orderedInputs.map(async (input) => {
        const referenceTime = input.episode.valid_at ?? input.episode.created_at;
        const previousEpisodes = await this.retrieveEpisodes(
          [input.episode.group_id],
          input.previous_episode_count ?? 5,
          referenceTime
        );
        const extraction = await this.episode_extractor.extract({
          episode: input.episode,
          previous_episodes: previousEpisodes.filter(
            (ep) => ep.uuid !== input.episode.uuid
          )
        });
        await this.enrichExtractionEmbeddings(extraction);
        const resolvedExtraction = await resolveEpisodeExtraction(
          this.driver,
          input.episode,
          extraction
        );
        return { input, previousEpisodes, resolvedExtraction };
      })
    );

    // Phase 2: Intra-batch entity deduplication (exact + fuzzy MinHash/LSH)
    const seenEntities = new Map<string, EntityNode>(); // uuid → entity (first occurrence)
    const allBatchEntities: EntityNode[] = [];

    for (const { resolvedExtraction } of extractionResults) {
      for (const entity of resolvedExtraction.entities) {
        if (!seenEntities.has(entity.uuid)) {
          seenEntities.set(entity.uuid, entity);
          allBatchEntities.push(entity);
        }
      }
    }

    // Build candidate indexes from all unique batch entities and resolve fuzzy matches
    const indexes = buildCandidateIndexes(allBatchEntities);
    const state: DedupResolutionState = {
      resolvedNodes: new Array(allBatchEntities.length).fill(null),
      uuidMap: new Map(),
      unresolvedIndices: [],
      duplicatePairs: []
    };
    resolveWithSimilarity(allBatchEntities, indexes, state);

    // Compress transitive chains via union-find
    const unionPairs: [string, string][] = [];
    for (const [source, target] of state.uuidMap) {
      if (source !== target) {
        unionPairs.push([source, target]);
      }
    }
    const uuidMap = unionPairs.length > 0
      ? buildDirectedUuidMap(unionPairs)
      : new Map<string, string>();

    // Phase 3: Apply UUID remapping and persist
    const results: IngestEpisodeResult[] = [];

    for (const { input, previousEpisodes, resolvedExtraction } of extractionResults) {
      const remappedEntities = resolvedExtraction.entities.filter(
        (entity) => !uuidMap.has(entity.uuid)
      );

      const allEdges = [
        ...resolvedExtraction.entity_edges,
        ...resolvedExtraction.invalidated_edges
      ];
      for (const edge of allEdges) {
        edge.source_node_uuid = uuidMap.get(edge.source_node_uuid) ?? edge.source_node_uuid;
        edge.target_node_uuid = uuidMap.get(edge.target_node_uuid) ?? edge.target_node_uuid;
      }

      const hydratedEntities = await this.node_hydrator.hydrate({
        episode: input.episode,
        previous_episodes: previousEpisodes,
        entities: remappedEntities,
        entity_edges: allEdges
      });

      input.episode.entity_edges = allEdges.map((edge) => edge.uuid);

      const result = await this.addEpisode({
        episode: input.episode,
        entities: hydratedEntities,
        entity_edges: allEdges
      });

      results.push({
        ...result,
        previous_episodes: previousEpisodes,
        extraction: {
          entities: hydratedEntities,
          entity_edges: allEdges
        }
      });
    }

    return { episodes: results };
  }

  // =========================================================================
  // Python-parity add_episode() — full LLM-driven extraction pipeline
  // =========================================================================

  /**
   * Process an episode and update the graph. Port of Python's add_episode().
   * This is the primary ingestion API with full support for custom entity types,
   * edge types, edge type maps, custom extraction instructions, and sagas.
   */
  async addEpisodeFull(input: AddEpisodeFullInput): Promise<AddEpisodeResult> {
    if (!this.clients) {
      throw new Error('LLM client, embedder, and cross encoder are all required for addEpisodeFull');
    }

    const now = utcNow();
    const groupId = input.group_id ?? this.driver.default_group_id;

    // FalkorDB: route to the correct database based on group_id
    if (this.driver instanceof FalkorDriver && groupId !== this.driver.database) {
      this.driver = this.driver.clone(groupId);
      if (this.clients) {
        this.clients.driver = this.driver;
      }
    }

    const scope = this.tracer.startSpan('add_episode');
    try {
      // Retrieve or create episode
      let episode: EpisodicNode;
      if (input.uuid) {
        episode = await this.nodes.episode.getByUuid(input.uuid);
      } else {
        episode = {
          uuid: crypto.randomUUID(),
          name: input.name,
          group_id: groupId,
          labels: [],
          source: input.source ?? EpisodeTypes.message,
          content: input.episode_body,
          source_description: input.source_description,
          created_at: now,
          valid_at: input.reference_time
        };
      }

      // Retrieve previous episodes for context
      const previousEpisodes = input.previous_episode_uuids
        ? await this.nodes.episode.getByUuids(input.previous_episode_uuids)
        : await this.retrieveEpisodes([groupId], 10, input.reference_time);

      // Build default edge type map
      const edgeTypeMap = input.edge_type_map ?? (
        input.edge_types
          ? { 'Entity,Entity': Object.keys(input.edge_types) }
          : { 'Entity,Entity': [] }
      );

      // Extract nodes
      const extractedNodes = await extractNodes(
        this.clients,
        episode,
        previousEpisodes,
        input.entity_types,
        input.excluded_entity_types,
        input.custom_extraction_instructions
      );

      // Resolve nodes against existing graph
      const [nodes, uuidMap] = await resolveExtractedNodes(
        this.clients,
        extractedNodes,
        episode,
        previousEpisodes,
        input.entity_types
      );

      // Extract edges
      const extractedEdgesRaw = await extractEdges(
        this.clients,
        episode,
        extractedNodes,
        previousEpisodes,
        edgeTypeMap,
        groupId,
        input.edge_types,
        input.custom_extraction_instructions
      );

      // Resolve edge pointers based on node dedup
      const extractedEdgesResolved = resolveEdgePointers(extractedEdgesRaw, uuidMap);

      // Resolve edges against existing graph
      const [resolvedEdges, invalidatedEdges, newEdges] = await resolveExtractedEdges(
        this.clients,
        extractedEdgesResolved,
        episode,
        nodes,
        input.edge_types ?? {},
        edgeTypeMap
      );

      const entityEdges = [...resolvedEdges, ...invalidatedEdges];

      // Extract node attributes — only pass new edges for summary generation
      const hydratedNodes = await extractAttributesFromNodes(
        this.clients,
        nodes,
        episode,
        previousEpisodes,
        input.entity_types,
        newEdges
      );

      // Build episodic edges (MENTIONS)
      const episodicEdges = buildEpisodicEdges(hydratedNodes, episode.uuid, now);
      episode.entity_edges = entityEdges.map((e) => e.uuid);

      // Clear raw content if configured
      if (!this.store_raw_episode_content) {
        episode.content = '';
      }

      // Persist everything
      await addNodesAndEdgesBulk(
        this.driver,
        [episode],
        episodicEdges,
        hydratedNodes,
        entityEdges,
        this.embedder!
      );

      // Handle saga association
      if (input.saga) {
        await this._processEpisodeSaga(
          episode,
          now,
          groupId,
          input.saga,
          input.saga_previous_episode_uuid ?? null
        );
      }

      // Update communities if requested
      let communities: CommunityNode[] = [];
      let communityEdges: CommunityEdge[] = [];
      if (input.update_communities) {
        const result = await this.buildCommunities([groupId]);
        communities = result.nodes;
        communityEdges = result.edges;
      }

      scope.span.addAttributes({
        'episode.uuid': episode.uuid,
        'node.count': hydratedNodes.length,
        'edge.count': entityEdges.length,
        'group_id': groupId
      });
      scope.span.setStatus('ok');

      return {
        episode,
        episodic_edges: episodicEdges,
        nodes: hydratedNodes,
        edges: entityEdges,
        communities,
        community_edges: communityEdges
      };
    } catch (error) {
      scope.span.setStatus('error', String(error));
      if (error instanceof Error) scope.span.recordException(error);
      throw error;
    } finally {
      scope.close();
    }
  }

  /**
   * Process multiple episodes in bulk with cross-episode dedup.
   * Port of Python's add_episode_bulk().
   */
  async addEpisodeBulkFull(input: AddEpisodeBulkInput): Promise<AddBulkEpisodeResults> {
    if (!this.clients) {
      throw new Error('LLM client, embedder, and cross encoder are all required');
    }

    const now = utcNow();
    const groupId = input.group_id ?? this.driver.default_group_id;

    // FalkorDB: route to the correct database based on group_id
    if (this.driver instanceof FalkorDriver && groupId !== this.driver.database) {
      this.driver = this.driver.clone(groupId);
      if (this.clients) {
        this.clients.driver = this.driver;
      }
    }

    const scope = this.tracer.startSpan('add_episode_bulk');
    scope.span.addAttributes({ 'episode.count': input.bulk_episodes.length });

    try {
      // Build default edge type map
      const edgeTypeMap = input.edge_type_map ?? (
        input.edge_types
          ? { 'Entity,Entity': Object.keys(input.edge_types) }
          : { 'Entity,Entity': [] }
      );

      // Create episode nodes
      const episodes: EpisodicNode[] = input.bulk_episodes.map((ep) => ({
        uuid: ep.uuid ?? crypto.randomUUID(),
        name: ep.name,
        group_id: groupId,
        labels: [],
        source: ep.source,
        content: ep.content,
        source_description: ep.source_description,
        created_at: now,
        valid_at: ep.reference_time
      }));

      // Save all episodes first
      await addNodesAndEdgesBulk(this.driver, episodes, [], [], [], this.embedder!);

      // Get previous episode context for each
      const episodeTuples: Array<[EpisodicNode, EpisodicNode[]]> = await semaphoreGather(
        episodes.map(
          (episode) => async () => {
            const prev = await this.retrieveEpisodes(
              [groupId],
              10,
              episode.valid_at ?? episode.created_at
            );
            return [episode, prev] as [EpisodicNode, EpisodicNode[]];
          }
        ),
        this.max_coroutines ?? 10
      );

      // Extract nodes and edges in parallel
      const [extractedNodesBulk, extractedEdgesBulk] = await extractNodesAndEdgesBulk(
        this.clients,
        episodeTuples,
        edgeTypeMap,
        input.entity_types,
        input.excluded_entity_types,
        input.edge_types,
        input.custom_extraction_instructions
      );

      // Cross-episode node dedup
      const [nodesByEpisode, nodeUuidMap] = await dedupeNodesBulk(
        this.clients,
        extractedNodesBulk,
        episodeTuples,
        input.entity_types
      );

      // Build episodic edges
      const allEpisodicEdges: EpisodicEdge[] = [];
      for (const [episodeUuid, nodes] of Object.entries(nodesByEpisode)) {
        allEpisodicEdges.push(...buildEpisodicEdges(nodes, episodeUuid, now));
      }

      // Re-map edge pointers and dedupe edges
      const remappedEdgesBulk = extractedEdgesBulk.map(
        (edges) => resolveEdgePointers(edges, nodeUuidMap)
      );

      const edgesByEpisode = await dedupeEdgesBulk(
        this.clients,
        remappedEdgesBulk,
        episodeTuples,
        input.edge_types ?? {}
      );

      // Resolve nodes and edges against existing graph
      const allNodes: EntityNode[] = Object.values(nodesByEpisode).flat();
      const uniqueNodesByUuid = new Map<string, EntityNode>();
      for (const node of allNodes) {
        uniqueNodesByUuid.set(node.uuid, node);
      }
      const uniqueNodes = Array.from(uniqueNodesByUuid.values());

      const allEdges: EntityEdge[] = Object.values(edgesByEpisode).flat();
      const uniqueEdgesByUuid = new Map<string, EntityEdge>();
      for (const edge of allEdges) {
        uniqueEdgesByUuid.set(edge.uuid, edge);
      }
      const uniqueEdges = Array.from(uniqueEdgesByUuid.values());

      // Extract attributes for all nodes
      const hydratedNodes = await extractAttributesFromNodes(
        this.clients,
        uniqueNodes,
        null,
        null,
        input.entity_types,
        uniqueEdges
      );

      // Set entity_edges on episodes
      for (const episode of episodes) {
        const edges = edgesByEpisode[episode.uuid] ?? [];
        episode.entity_edges = edges.map((e) => e.uuid);
      }

      // Persist
      await addNodesAndEdgesBulk(
        this.driver,
        episodes,
        allEpisodicEdges,
        hydratedNodes,
        uniqueEdges,
        this.embedder!
      );

      // Handle saga association
      if (input.saga) {
        const sagaNode = typeof input.saga === 'string'
          ? await this._getOrCreateSaga(input.saga, groupId, now)
          : input.saga;

        const sortedEpisodes = [...episodes].sort(
          (a, b) => (a.valid_at?.getTime() ?? 0) - (b.valid_at?.getTime() ?? 0)
        );

        // Find most recent episode already in the saga
        const prevResult = await this.driver.executeQuery<{ uuid: string }>(
          `
          MATCH (s:Saga {uuid: $saga_uuid})-[:HAS_EPISODE]->(e:Episodic)
          RETURN e.uuid AS uuid
          ORDER BY e.valid_at DESC, e.created_at DESC
          LIMIT 1
          `,
          { params: { saga_uuid: sagaNode.uuid }, routing: 'r' }
        );

        let prevEpisodeUuid = prevResult.records[0]?.uuid ?? null;

        for (const episode of sortedEpisodes) {
          if (prevEpisodeUuid) {
            await this._saveNextEpisodeEdge(prevEpisodeUuid, episode.uuid, groupId, now);
          }
          await this._saveHasEpisodeEdge(sagaNode.uuid, episode.uuid, groupId, now);
          prevEpisodeUuid = episode.uuid;
        }
      }

      scope.span.addAttributes({
        'group_id': groupId,
        'node.count': hydratedNodes.length,
        'edge.count': uniqueEdges.length
      });
      scope.span.setStatus('ok');

      return {
        episodes,
        episodic_edges: allEpisodicEdges,
        nodes: hydratedNodes,
        edges: uniqueEdges,
        communities: [],
        community_edges: []
      };
    } catch (error) {
      scope.span.setStatus('error', String(error));
      if (error instanceof Error) scope.span.recordException(error);
      throw error;
    } finally {
      scope.close();
    }
  }

  // =========================================================================
  // Saga support — port of Python's _get_or_create_saga()
  // =========================================================================

  async _getOrCreateSaga(sagaName: string, groupId: string, now: Date): Promise<SagaNode> {
    const result = await this.driver.executeQuery<{
      uuid: string;
      name: string;
      group_id: string;
      created_at: string;
    }>(
      `
      MATCH (s:Saga {name: $name, group_id: $group_id})
      RETURN s.uuid AS uuid, s.name AS name, s.group_id AS group_id, s.created_at AS created_at
      `,
      { params: { name: sagaName, group_id: groupId }, routing: 'r' }
    );

    if (result.records.length > 0) {
      const record = result.records[0]!;
      return {
        uuid: record.uuid,
        name: record.name,
        group_id: record.group_id,
        labels: ['Saga'],
        created_at: new Date(record.created_at),
        summary: ''
      };
    }

    // Create new saga
    const saga: SagaNode = {
      uuid: crypto.randomUUID(),
      name: sagaName,
      group_id: groupId,
      labels: ['Saga'],
      created_at: now,
      summary: ''
    };

    await this.driver.executeQuery(
      `
      CREATE (s:Saga {uuid: $uuid, name: $name, group_id: $group_id, created_at: $created_at})
      RETURN s.uuid AS uuid
      `,
      {
        params: {
          uuid: saga.uuid,
          name: saga.name,
          group_id: saga.group_id,
          created_at: saga.created_at.toISOString()
        }
      }
    );

    return saga;
  }

  private async _processEpisodeSaga(
    episode: EpisodicNode,
    now: Date,
    groupId: string,
    saga: string | SagaNode,
    sagaPreviousEpisodeUuid: string | null
  ): Promise<void> {
    const sagaNode = typeof saga === 'string'
      ? await this._getOrCreateSaga(saga, groupId, now)
      : saga;

    let previousEpisodeUuid = sagaPreviousEpisodeUuid;
    if (!previousEpisodeUuid) {
      const prevResult = await this.driver.executeQuery<{ uuid: string }>(
        `
        MATCH (s:Saga {uuid: $saga_uuid})-[:HAS_EPISODE]->(e:Episodic)
        WHERE e.uuid <> $current_episode_uuid
        RETURN e.uuid AS uuid
        ORDER BY e.valid_at DESC, e.created_at DESC
        LIMIT 1
        `,
        {
          params: { saga_uuid: sagaNode.uuid, current_episode_uuid: episode.uuid },
          routing: 'r'
        }
      );
      previousEpisodeUuid = prevResult.records[0]?.uuid ?? null;
    }

    if (previousEpisodeUuid) {
      await this._saveNextEpisodeEdge(previousEpisodeUuid, episode.uuid, groupId, now);
    }

    await this._saveHasEpisodeEdge(sagaNode.uuid, episode.uuid, groupId, now);
  }

  private async _saveNextEpisodeEdge(
    sourceUuid: string,
    targetUuid: string,
    groupId: string,
    createdAt: Date
  ): Promise<void> {
    await this.driver.executeQuery(
      `
      MATCH (source:Episodic {uuid: $source_uuid})
      MATCH (target:Episodic {uuid: $target_uuid})
      MERGE (source)-[e:NEXT_EPISODE]->(target)
      SET e.uuid = $uuid, e.group_id = $group_id, e.created_at = $created_at
      RETURN e.uuid AS uuid
      `,
      {
        params: {
          uuid: crypto.randomUUID(),
          source_uuid: sourceUuid,
          target_uuid: targetUuid,
          group_id: groupId,
          created_at: createdAt.toISOString()
        }
      }
    );
  }

  private async _saveHasEpisodeEdge(
    sagaUuid: string,
    episodeUuid: string,
    groupId: string,
    createdAt: Date
  ): Promise<void> {
    await this.driver.executeQuery(
      `
      MATCH (s:Saga {uuid: $saga_uuid})
      MATCH (e:Episodic {uuid: $episode_uuid})
      MERGE (s)-[r:HAS_EPISODE]->(e)
      SET r.uuid = $uuid, r.group_id = $group_id, r.created_at = $created_at
      RETURN r.uuid AS uuid
      `,
      {
        params: {
          uuid: crypto.randomUUID(),
          saga_uuid: sagaUuid,
          episode_uuid: episodeUuid,
          group_id: groupId,
          created_at: createdAt.toISOString()
        }
      }
    );
  }

  // =========================================================================
  // Enhanced addTriplet with resolution — port of Python's add_triplet()
  // =========================================================================

  /**
   * Add a triplet with full resolution against the existing graph.
   * Port of Python's add_triplet() which includes node resolution,
   * edge dedup, and contradiction detection.
   */
  async addTripletFull(input: AddTripletInput): Promise<AddTripletResult> {
    if (!this.clients || !this.embedder) {
      throw new Error('LLM client and embedder are required for addTripletFull');
    }

    // Generate embeddings
    if (!input.source.name_embedding) {
      input.source.name_embedding = await this.embedder.create([
        input.source.name.replaceAll('\n', ' ')
      ]);
    }
    if (!input.target.name_embedding) {
      input.target.name_embedding = await this.embedder.create([
        input.target.name.replaceAll('\n', ' ')
      ]);
    }
    if (!input.edge.fact_embedding) {
      input.edge.fact_embedding = await this.embedder.create([
        input.edge.fact.replaceAll('\n', ' ')
      ]);
    }

    // Resolve source node
    let resolvedSource: EntityNode;
    try {
      resolvedSource = await this.nodes.entity.getByUuid(input.source.uuid);
    } catch {
      const [resolvedNodes] = await resolveExtractedNodes(this.clients, [input.source]);
      resolvedSource = resolvedNodes[0] ?? input.source;
    }

    // Resolve target node
    let resolvedTarget: EntityNode;
    try {
      resolvedTarget = await this.nodes.entity.getByUuid(input.target.uuid);
    } catch {
      const [resolvedNodes] = await resolveExtractedNodes(this.clients, [input.target]);
      resolvedTarget = resolvedNodes[0] ?? input.target;
    }

    // Merge attributes from original nodes
    if (input.source.attributes) {
      resolvedSource.attributes = { ...(resolvedSource.attributes ?? {}), ...input.source.attributes };
    }
    if (input.target.attributes) {
      resolvedTarget.attributes = { ...(resolvedTarget.attributes ?? {}), ...input.target.attributes };
    }
    if (input.source.summary) resolvedSource.summary = input.source.summary;
    if (input.target.summary) resolvedTarget.summary = input.target.summary;
    if (input.source.labels?.length) {
      resolvedSource.labels = [...new Set([...resolvedSource.labels, ...input.source.labels])];
    }
    if (input.target.labels?.length) {
      resolvedTarget.labels = [...new Set([...resolvedTarget.labels, ...input.target.labels])];
    }

    // Update edge pointers
    const edge = { ...input.edge };
    edge.source_node_uuid = resolvedSource.uuid;
    edge.target_node_uuid = resolvedTarget.uuid;

    // Check for existing edge UUID collision
    try {
      const existingEdge = await this.edges.entity.getByUuid(edge.uuid);
      if (
        existingEdge.source_node_uuid !== edge.source_node_uuid ||
        existingEdge.target_node_uuid !== edge.target_node_uuid
      ) {
        edge.uuid = crypto.randomUUID();
      }
    } catch {
      // Edge doesn't exist — proceed normally
    }

    // Search for related edges for dedup
    const validEdges = await this._getEdgesBetweenNodes(
      edge.source_node_uuid,
      edge.target_node_uuid
    );

    const relatedResults = await search(
      this.driver,
      edge.fact,
      [edge.group_id],
      EDGE_HYBRID_SEARCH_RRF,
      createSearchFilters({ edge_uuids: validEdges.map((e) => e.uuid) }),
      {},
      this.cross_encoder
    );

    const existingResults = await search(
      this.driver,
      edge.fact,
      [edge.group_id],
      EDGE_HYBRID_SEARCH_RRF,
      createSearchFilters(),
      {},
      this.cross_encoder
    );

    // Resolve edge
    const dummyEpisode: EpisodicNode = {
      uuid: crypto.randomUUID(),
      name: '',
      group_id: edge.group_id,
      labels: [],
      source: EpisodeTypes.text,
      source_description: '',
      content: '',
      created_at: utcNow(),
      valid_at: edge.valid_at ?? utcNow(),
      entity_edges: []
    };

    const [resolvedEdge, invalidatedEdges] = await resolveExtractedEdge(
      this.clients.llm_client,
      edge,
      relatedResults.edges,
      existingResults.edges,
      dummyEpisode
    );

    const allEdges = [resolvedEdge, ...invalidatedEdges];
    const allNodes = [resolvedSource, resolvedTarget];

    // Save
    await addNodesAndEdgesBulk(this.driver, [], [], allNodes, allEdges, this.embedder);

    return {
      nodes: [resolvedSource, resolvedTarget],
      edges: [resolvedEdge]
    };
  }

  private async _getEdgesBetweenNodes(
    sourceUuid: string,
    targetUuid: string
  ): Promise<EntityEdge[]> {
    const result = await this.driver.executeQuery<Record<string, unknown>>(
      `
      MATCH (source:Entity {uuid: $source_uuid})-[e:RELATES_TO]->(target:Entity {uuid: $target_uuid})
      RETURN e.uuid AS uuid, e.group_id AS group_id, source.uuid AS source_node_uuid,
             target.uuid AS target_node_uuid, e.created_at AS created_at,
             e.name AS name, e.fact AS fact, e.episodes AS episodes,
             e.valid_at AS valid_at, e.invalid_at AS invalid_at, e.confidence AS confidence,
             e.epistemic_status AS epistemic_status, e.supported_by AS supported_by,
             e.supports AS supports, e.disputed_by AS disputed_by,
             e.epistemic_history AS epistemic_history, e.birth_score AS birth_score
      `,
      { params: { source_uuid: sourceUuid, target_uuid: targetUuid }, routing: 'r' }
    );

    return result.records.map((r) => ({
      uuid: r.uuid as string,
      group_id: (r.group_id as string) ?? '',
      source_node_uuid: r.source_node_uuid as string,
      target_node_uuid: r.target_node_uuid as string,
      created_at: new Date(r.created_at as string),
      name: (r.name as string) ?? '',
      fact: (r.fact as string) ?? '',
      episodes: (r.episodes as string[]) ?? [],
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

  async retrieveEpisodes(
    groupIds: string[],
    lastN = 10,
    referenceTime?: Date | null
  ): Promise<EpisodicNode[]> {
    // FalkorDB multi-group routing: execute per group_id with cloned driver
    if (needsMultiGroupRouting(this.driver, groupIds)) {
      return executeWithMultiGroupRouting(
        this.driver,
        groupIds,
        async (driver, singleGroupIds) => {
          // Use the episode namespace with the cloned driver's database
          return this.nodes.episode.getByGroupIds(singleGroupIds, lastN, referenceTime);
        },
        this.max_coroutines
      );
    }
    return this.nodes.episode.getByGroupIds(groupIds, lastN, referenceTime);
  }

  async deleteEntityEdge(uuid: string): Promise<void> {
    await this.edges.entity.deleteByUuid(uuid);
  }

  async deleteEpisode(uuid: string): Promise<void> {
    await this.nodes.episode.deleteByUuid(uuid);
  }

  /**
   * Remove an episode with full cleanup — deletes orphaned edges and nodes.
   * Port of Python's `remove_episode()` method.
   *
   * 1. Finds entity edges created by this episode (where it's the first episode in the list)
   * 2. Finds entity nodes only mentioned by this episode
   * 3. Deletes orphaned edges and nodes
   * 4. Deletes the episode itself
   */
  async removeEpisode(episodeUuid: string): Promise<void> {
    // Load the episode to find its edges
    const episode = await this.nodes.episode.getByUuid(episodeUuid);
    const entityEdgeUuids = episode.entity_edges ?? [];

    // Load edges mentioned by the episode
    const edges = await this.edges.entity.getByUuids(entityEdgeUuids);

    // Only delete edges where this episode is the first (creating) episode
    const edgesToDelete = edges.filter(
      (edge) => edge.episodes && edge.episodes[0] === episode.uuid
    );

    // Find nodes mentioned only by this episode via MENTIONS edges
    const mentionedNodeResult = await this.driver.executeQuery<{ uuid: string; episode_count: number }>(
      `
        MATCH (ep:Episodic {uuid: $episode_uuid})-[:MENTIONS]->(n:Entity)
        WITH n
        MATCH (e2:Episodic)-[:MENTIONS]->(n)
        WITH n, count(e2) AS episode_count
        RETURN n.uuid AS uuid, episode_count
      `,
      { params: { episode_uuid: episodeUuid }, routing: 'r' }
    );

    const nodesToDelete = mentionedNodeResult.records
      .filter((record) => {
        const count = typeof record.episode_count === 'object' && record.episode_count !== null && 'low' in record.episode_count
          ? (record.episode_count as { low: number }).low
          : record.episode_count;
        return count === 1;
      })
      .map((record) => record.uuid);

    // Delete orphaned edges
    if (edgesToDelete.length > 0) {
      await this.edges.entity.deleteByUuids(edgesToDelete.map((e) => e.uuid));
    }

    // Delete orphaned nodes
    if (nodesToDelete.length > 0) {
      await this.nodes.entity.deleteByUuids(nodesToDelete);
    }

    // Delete the episode itself (cascades MENTIONS edges via DETACH DELETE)
    await this.nodes.episode.deleteByUuid(episodeUuid);
  }

  async deleteGroup(groupId: string): Promise<void> {
    const transaction = await this.driver.transaction();

    try {
      await this.edges.entity.deleteByGroupId(groupId);
      await this.nodes.episode.deleteByGroupId(groupId);
      await this.nodes.entity.deleteByGroupId(groupId);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async clear(): Promise<void> {
    const transaction = await this.driver.transaction();

    try {
      await this.driver.executeQuery(
        `
          MATCH (n)
          WITH collect(n) AS nodes
          FOREACH (node IN nodes | DETACH DELETE node)
          RETURN size(nodes) AS deleted_count
        `
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async buildCommunities(
    groupIds: string[] | null = null
  ): Promise<{ nodes: import('./domain/nodes').CommunityNode[]; edges: import('./domain/edges').CommunityEdge[] }> {
    if (!this.llm_client) {
      throw new Error('LLM client is required for building communities');
    }

    // FalkorDB multi-group routing
    if (needsMultiGroupRouting(this.driver, groupIds)) {
      return executeWithMultiGroupRouting(
        this.driver,
        groupIds!,
        async (_driver, singleGroupIds) => {
          return this._buildCommunitiesForGroups(singleGroupIds);
        },
        this.max_coroutines
      );
    }

    return this._buildCommunitiesForGroups(groupIds);
  }

  private async _buildCommunitiesForGroups(
    groupIds: string[] | null
  ): Promise<{ nodes: import('./domain/nodes').CommunityNode[]; edges: import('./domain/edges').CommunityEdge[] }> {
    await removeCommunities(this.driver);

    const [communityNodes, communityEdges] = await buildCommunitiesOp(
      this.driver,
      this.llm_client!,
      this.nodes.entity,
      groupIds
    );

    await this.communities.node.saveBulk(communityNodes);
    await this.communities.edge.saveBulk(communityEdges);

    return { nodes: communityNodes, edges: communityEdges };
  }

  async updateCommunity(
    entity: EntityNode
  ): Promise<{ nodes: import('./domain/nodes').CommunityNode[]; edges: import('./domain/edges').CommunityEdge[] }> {
    if (!this.llm_client) {
      throw new Error('LLM client is required for updating communities');
    }
    if (!this.embedder) {
      throw new Error('Embedder is required for updating communities');
    }

    const [nodes, edges] = await updateCommunityOp(
      this.driver,
      this.llm_client,
      this.embedder,
      this.communities,
      entity
    );

    return { nodes, edges };
  }

  private async enrichExtractionEmbeddings(extraction: EpisodeExtractionResult): Promise<void> {
    if (!this.embedder) {
      return;
    }

    for (const entity of extraction.entities) {
      if (!entity.name_embedding) {
        entity.name_embedding = await this.embedder.create([entity.name.replaceAll('\n', ' ')]);
      }
    }

    for (const edge of extraction.entity_edges) {
      if (!edge.fact_embedding) {
        edge.fact_embedding = await this.embedder.create([edge.fact.replaceAll('\n', ' ')]);
      }
    }
  }

  /**
   * Advanced search returning full SearchResults with nodes, edges, communities, and episodes.
   * This is the TypeScript equivalent of Python's `search_()` method.
   * Alias for `search()` with the same signature.
   */
  async advancedSearch(
    query: string,
    config: SearchConfig,
    options: GraphitiSearchOptions = {}
  ): Promise<SearchResults> {
    return this.search(query, config, options);
  }

  async searchEdges(
    query: string,
    options: {
      group_ids?: string[] | null;
      center_node_uuid?: string | null;
      num_results?: number;
      search_filter?: SearchFilters;
    } = {}
  ): Promise<SearchResults['edges']> {
    const baseConfig = options.center_node_uuid
      ? EDGE_HYBRID_SEARCH_NODE_DISTANCE
      : EDGE_HYBRID_SEARCH_RRF;
    const config = createSearchConfig({ ...baseConfig, limit: options.num_results ?? 10 });
    const searchOptions: GraphitiSearchOptions = {};
    if (options.group_ids !== undefined) searchOptions.group_ids = options.group_ids;
    if (options.center_node_uuid !== undefined) searchOptions.center_node_uuid = options.center_node_uuid;
    if (options.search_filter !== undefined) searchOptions.search_filter = options.search_filter;
    const results = await this.search(query, config, searchOptions);
    return results.edges;
  }

  async searchAsOf(
    query: string,
    asOfDate: Date,
    options?: { group_ids?: string[] | null; num_results?: number }
  ): Promise<SearchResults['edges']> {
    return this.searchEdges(query, {
      ...options,
      search_filter: createSearchFilters({
        valid_at: [[
          { date: asOfDate, comparison_operator: '<=' },
        ]],
        invalid_at: [[
          { date: asOfDate, comparison_operator: '>' },
          { comparison_operator: 'IS NULL' },
        ]],
      }),
    });
  }

  async getNodesAndEdgesByEpisode(episodeUuids: string[]): Promise<SearchResults> {
    if (episodeUuids.length === 0) {
      return {
        nodes: [],
        node_reranker_scores: [],
        edges: [],
        edge_reranker_scores: [],
        episodes: [],
        episode_reranker_scores: [],
        communities: [],
        community_reranker_scores: []
      };
    }

    const episodes = await this.nodes.episode.getByUuids(episodeUuids);

    const allEdgeUuids = [...new Set(episodes.flatMap((ep) => ep.entity_edges ?? []))];
    const edges = await this.edges.entity.getByUuids(allEdgeUuids);

    const allNodeUuids = [
      ...new Set(edges.flatMap((edge) => [edge.source_node_uuid, edge.target_node_uuid]))
    ];
    const nodes = await this.nodes.entity.getByUuids(allNodeUuids);

    return {
      nodes,
      node_reranker_scores: [],
      edges,
      edge_reranker_scores: [],
      episodes: [],
      episode_reranker_scores: [],
      communities: [],
      community_reranker_scores: []
    };
  }

  async search(
    query: string,
    config: SearchConfig,
    options: GraphitiSearchOptions = {}
  ): Promise<SearchResults> {
    // FalkorDB multi-group routing
    if (needsMultiGroupRouting(this.driver, options.group_ids)) {
      return executeWithMultiGroupRouting(
        this.driver,
        options.group_ids!,
        async (driver, singleGroupIds) => {
          return this._executeSearch(
            driver,
            query,
            config,
            { ...options, group_ids: singleGroupIds }
          );
        },
        this.max_coroutines
      );
    }

    return this._executeSearch(this.driver, query, config, options);
  }

  private async _executeSearch(
    driver: GraphDriver,
    query: string,
    config: SearchConfig,
    options: GraphitiSearchOptions
  ): Promise<SearchResults> {
    const needsQueryEmbedding =
      config.node_config?.search_methods.includes('cosine_similarity') === true ||
      config.edge_config?.search_methods.includes('cosine_similarity') === true ||
      config.node_config?.reranker === NodeRerankers.mmr ||
      config.edge_config?.reranker === EdgeRerankers.mmr;
    let queryEmbedding: number[] | null = null;

    if (needsQueryEmbedding) {
      if (!this.embedder) {
        throw new SearchRerankerError(
          'No embedder configured for cosine similarity search'
        );
      }

      queryEmbedding = await this.embedder.create(query.replaceAll('\n', ' '));
    }

    const executionOptions =
      options.bfs_origin_node_uuids === undefined &&
      options.center_node_uuid === undefined &&
      queryEmbedding === null
        ? {}
        : {
            ...(options.bfs_origin_node_uuids === undefined
              ? {}
              : { bfs_origin_node_uuids: options.bfs_origin_node_uuids }),
            ...(options.center_node_uuid === undefined
              ? {}
              : { center_node_uuid: options.center_node_uuid }),
            ...(queryEmbedding === null ? {} : { query_embedding: queryEmbedding })
          };

    return search(
      driver,
      query,
      options.group_ids,
      config,
      options.search_filter ?? createSearchFilters(),
      executionOptions,
      this.cross_encoder
    );
  }
}

function hasOpenAIKey(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      typeof process.env?.OPENAI_API_KEY === 'string' &&
      process.env.OPENAI_API_KEY !== ''
    );
  } catch {
    return false;
  }
}

function createDefaultLLMClient(): LLMClient | null {
  return hasOpenAIKey() ? new OpenAIClient() : null;
}

function createDefaultEmbedder(): EmbedderClient | null {
  return hasOpenAIKey() ? new OpenAIEmbedder() : null;
}

function createDefaultReranker(): CrossEncoderClient | null {
  return hasOpenAIKey() ? new OpenAIRerankerClient() : null;
}
