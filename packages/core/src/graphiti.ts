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
  createGraphitiConfig,
  type GraphitiConfig,
  type GraphitiConfigOverrides
} from './config';
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
  type BulkEmbeddingOptions,
  type RawEpisode
} from './maintenance/bulk-utils';

export interface GraphitiOptions {
  driver: GraphDriver;
  config?: GraphitiConfigOverrides;
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
  readonly config: GraphitiConfig;

  constructor(options: GraphitiOptions) {
    this.driver = options.driver;
    this.config = createGraphitiConfig(options.config);
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
    this.nodes = createNodeNamespace(() => this.driver, this.embedder);
    this.edges = createEdgeNamespace(() => this.driver, this.embedder);
    this.communities = createCommunityNamespace(() => this.driver, this.embedder);
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
            cache: this.llmCache,
            modelRouting: this.config.model_routing
          }
        : null;

    if (this.llm_client) {
      this.llm_client.setTracer(this.tracer);
    }

    // Capture initialization telemetry
    this._captureInitializationTelemetry();
  }

  private getScopedDriver(groupId?: string | null): GraphDriver {
    if (
      this.driver instanceof FalkorDriver &&
      groupId &&
      groupId !== this.driver.database
    ) {
      return this.driver.clone(groupId);
    }
    return this.driver;
  }

  private getScopedDriverForGroups(groupIds?: string[] | null): GraphDriver {
    return groupIds && groupIds.length === 1
      ? this.getScopedDriver(groupIds[0]!)
      : this.driver;
  }

  private getScopedClients(driver: GraphDriver): GraphitiClients {
    if (!this.clients) {
      throw new Error('LLM client, embedder, and cross encoder are all required');
    }

    return driver === this.driver
      ? this.clients
      : {
          ...this.clients,
          driver
        };
  }

  private getDefaultExtractionInstructions(
    source?: EpisodeType | null
  ): string | null {
    if (!source) {
      return null;
    }
    return this.config.extraction.default_instructions_by_episode_source?.[source] ?? null;
  }

  private getBulkEmbeddingOptions(): BulkEmbeddingOptions {
    const preferBatchEmbeddings = this.config.bulk_ingest.prefer_batch_embeddings;
    return preferBatchEmbeddings === undefined
      ? {}
      : { prefer_batch_embeddings: preferBatchEmbeddings };
  }

  private getNodeNamespace(driver: GraphDriver = this.driver): NodeNamespaceApi {
    return createNodeNamespace(driver, this.embedder);
  }

  private getEdgeNamespace(driver: GraphDriver = this.driver): EdgeNamespaceApi {
    return createEdgeNamespace(driver, this.embedder);
  }

  private getCommunityNamespace(driver: GraphDriver = this.driver): CommunityNamespaceApi {
    return createCommunityNamespace(driver, this.embedder);
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
    const driver = this.getScopedDriver(input.edge.group_id);
    const nodeNamespace = this.getNodeNamespace(driver);
    const edges = this.getEdgeNamespace(driver);

    await nodeNamespace.entity.save(input.source);
    await nodeNamespace.entity.save(input.target);
    await edges.entity.save(input.edge);

    return {
      nodes: [input.source, input.target],
      edges: [input.edge]
    };
  }

  async addEpisode(input: AddEpisodeInput): Promise<AddEpisodeResult> {
    const driver = this.getScopedDriver(input.episode.group_id);
    const nodeNamespace = this.getNodeNamespace(driver);
    const edgesNamespace = this.getEdgeNamespace(driver);
    const entities = input.entities ?? [];
    const edges = input.entity_edges ?? [];
    const episodicEdges: EpisodicEdge[] = [];

    for (const entity of entities) {
      await nodeNamespace.entity.save(entity);
    }

    await nodeNamespace.episode.save(input.episode);

    for (const edge of edges) {
      await edgesNamespace.entity.save(edge);
    }

    for (const entity of entities) {
      const episodicEdge: EpisodicEdge = {
        uuid: `${input.episode.uuid}:${entity.uuid}`,
        group_id: input.episode.group_id,
        source_node_uuid: input.episode.uuid,
        target_node_uuid: entity.uuid,
        created_at: input.episode.created_at
      };
      await edgesNamespace.episodic.save(episodicEdge);
      episodicEdges.push(episodicEdge);
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
    const driver = this.getScopedDriver(input.episode.group_id);
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
      ),
      extraction_instructions:
        input.extraction_instructions ??
        this.getDefaultExtractionInstructions(input.episode.source)
    });
    await this.enrichExtractionEmbeddings(extraction);
    const resolvedExtraction = await resolveEpisodeExtraction(
      driver,
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
        const driver = this.getScopedDriver(input.episode.group_id);
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
          driver,
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
    const driver = this.getScopedDriver(groupId);
    const nodeNamespace = this.getNodeNamespace(driver);
    const scopedClients = this.getScopedClients(driver);

    const scope = this.tracer.startSpan('add_episode');
    try {
      // Retrieve or create episode
      let episode: EpisodicNode;
      if (input.uuid) {
        episode = await nodeNamespace.episode.getByUuid(input.uuid);
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
        ? await nodeNamespace.episode.getByUuids(input.previous_episode_uuids)
        : await this.retrieveEpisodes([groupId], 10, input.reference_time);

      // Build default edge type map
      const edgeTypeMap = input.edge_type_map ?? (
        input.edge_types
          ? { 'Entity,Entity': Object.keys(input.edge_types) }
          : { 'Entity,Entity': [] }
      );

      // Extract nodes
      const extractedNodes = await extractNodes(
        scopedClients,
        episode,
        previousEpisodes,
        input.entity_types,
        input.excluded_entity_types,
        input.custom_extraction_instructions ??
          this.getDefaultExtractionInstructions(episode.source)
      );

      // Resolve nodes against existing graph
      const [nodes, uuidMap] = await resolveExtractedNodes(
        scopedClients,
        extractedNodes,
        episode,
        previousEpisodes,
        input.entity_types,
        undefined,
        this.config.resolution
      );

      // Extract edges
      const extractedEdgesRaw = await extractEdges(
        scopedClients,
        episode,
        extractedNodes,
        previousEpisodes,
        edgeTypeMap,
        groupId,
        input.edge_types,
        input.custom_extraction_instructions ??
          this.getDefaultExtractionInstructions(episode.source)
      );

      // Resolve edge pointers based on node dedup
      const extractedEdgesResolved = resolveEdgePointers(extractedEdgesRaw, uuidMap);

      // Resolve edges against existing graph
      const [resolvedEdges, invalidatedEdges, newEdges] = await resolveExtractedEdges(
        scopedClients,
        extractedEdgesResolved,
        episode,
        nodes,
        input.edge_types ?? {},
        edgeTypeMap,
        this.config.lifecycle.deprecation_gate,
        this.config.resolution
      );

      const entityEdges = [...resolvedEdges, ...invalidatedEdges];

      // Extract node attributes — only pass new edges for summary generation
      const hydratedNodes = await extractAttributesFromNodes(
        scopedClients,
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
        driver,
        [episode],
        episodicEdges,
        hydratedNodes,
        entityEdges,
        this.embedder!,
        this.getBulkEmbeddingOptions()
      );

      // Handle saga association
      if (input.saga) {
        await this._processEpisodeSaga(
          driver,
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
        const result = await this._buildCommunitiesForGroups(driver, [groupId]);
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
    const driver = this.getScopedDriver(groupId);
    const scopedClients = this.getScopedClients(driver);

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
      await addNodesAndEdgesBulk(
        driver,
        episodes,
        [],
        [],
        [],
        this.embedder!,
        this.getBulkEmbeddingOptions()
      );

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
        scopedClients,
        episodeTuples,
        edgeTypeMap,
        input.entity_types,
        input.excluded_entity_types,
        input.edge_types,
        input.custom_extraction_instructions,
        (episode) => this.getDefaultExtractionInstructions(episode.source)
      );

      // Cross-episode node dedup
      const [nodesByEpisode, nodeUuidMap] = await dedupeNodesBulk(
        scopedClients,
        extractedNodesBulk,
        episodeTuples,
        input.entity_types,
        this.config.resolution
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
        scopedClients,
        remappedEdgesBulk,
        episodeTuples,
        input.edge_types ?? {},
        this.config.lifecycle.deprecation_gate === undefined &&
        this.config.bulk_ingest.prefer_batch_embeddings === undefined
          ? {}
          : {
              ...(this.config.lifecycle.deprecation_gate === undefined
                ? {}
                : { deprecation_gate_config: this.config.lifecycle.deprecation_gate }),
              resolution_config: this.config.resolution,
              ...this.getBulkEmbeddingOptions()
            }
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
        scopedClients,
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
        driver,
        episodes,
        allEpisodicEdges,
        hydratedNodes,
        uniqueEdges,
        this.embedder!,
        this.getBulkEmbeddingOptions()
      );

      // Handle saga association
      if (input.saga) {
        const sagaNode = typeof input.saga === 'string'
          ? await this._getOrCreateSaga(driver, input.saga, groupId, now)
          : input.saga;

        const sortedEpisodes = [...episodes].sort(
          (a, b) => (a.valid_at?.getTime() ?? 0) - (b.valid_at?.getTime() ?? 0)
        );

        // Find most recent episode already in the saga
        const prevResult = await driver.executeQuery<{ uuid: string }>(
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
            await this._saveNextEpisodeEdge(driver, prevEpisodeUuid, episode.uuid, groupId, now);
          }
          await this._saveHasEpisodeEdge(driver, sagaNode.uuid, episode.uuid, groupId, now);
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

  async _getOrCreateSaga(
    driver: GraphDriver,
    sagaName: string,
    groupId: string,
    now: Date
  ): Promise<SagaNode> {
    const result = await driver.executeQuery<{
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

    await driver.executeQuery(
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
    driver: GraphDriver,
    episode: EpisodicNode,
    now: Date,
    groupId: string,
    saga: string | SagaNode,
    sagaPreviousEpisodeUuid: string | null
  ): Promise<void> {
    const sagaNode = typeof saga === 'string'
      ? await this._getOrCreateSaga(driver, saga, groupId, now)
      : saga;

    let previousEpisodeUuid = sagaPreviousEpisodeUuid;
    if (!previousEpisodeUuid) {
      const prevResult = await driver.executeQuery<{ uuid: string }>(
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
      await this._saveNextEpisodeEdge(driver, previousEpisodeUuid, episode.uuid, groupId, now);
    }

    await this._saveHasEpisodeEdge(driver, sagaNode.uuid, episode.uuid, groupId, now);
  }

  private async _saveNextEpisodeEdge(
    driver: GraphDriver,
    sourceUuid: string,
    targetUuid: string,
    groupId: string,
    createdAt: Date
  ): Promise<void> {
    await driver.executeQuery(
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
    driver: GraphDriver,
    sagaUuid: string,
    episodeUuid: string,
    groupId: string,
    createdAt: Date
  ): Promise<void> {
    await driver.executeQuery(
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
    const driver = this.getScopedDriver(input.edge.group_id);
    const nodes = this.getNodeNamespace(driver);
    const edges = this.getEdgeNamespace(driver);
    const scopedClients = this.getScopedClients(driver);

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
      resolvedSource = await nodes.entity.getByUuid(input.source.uuid);
    } catch {
      const [resolvedNodes] = await resolveExtractedNodes(scopedClients, [input.source], undefined, undefined, undefined, undefined, this.config.resolution);
      resolvedSource = resolvedNodes[0] ?? input.source;
    }

    // Resolve target node
    let resolvedTarget: EntityNode;
    try {
      resolvedTarget = await nodes.entity.getByUuid(input.target.uuid);
    } catch {
      const [resolvedNodes] = await resolveExtractedNodes(scopedClients, [input.target], undefined, undefined, undefined, undefined, this.config.resolution);
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
      const existingEdge = await edges.entity.getByUuid(edge.uuid);
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
      driver,
      edge.source_node_uuid,
      edge.target_node_uuid
    );

    const relatedResults = await search(
      driver,
      edge.fact,
      [edge.group_id],
      EDGE_HYBRID_SEARCH_RRF,
      createSearchFilters({ edge_uuids: validEdges.map((e) => e.uuid) }),
      {},
      this.cross_encoder
    );

    const existingResults = await search(
      driver,
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
      scopedClients.llm_client,
      edge,
      relatedResults.edges,
      relatedResults.edge_reranker_scores,
      existingResults.edges,
      dummyEpisode,
      undefined,
      undefined,
      this.config.lifecycle.deprecation_gate,
      this.config.resolution,
      this.tracer
    );

    const allEdges = [resolvedEdge, ...invalidatedEdges];
    const allNodes = [resolvedSource, resolvedTarget];

    // Save
    await addNodesAndEdgesBulk(
      driver,
      [],
      [],
      allNodes,
      allEdges,
      this.embedder,
      this.getBulkEmbeddingOptions()
    );

    return {
      nodes: [resolvedSource, resolvedTarget],
      edges: [resolvedEdge]
    };
  }

  private async _getEdgesBetweenNodes(
    driver: GraphDriver,
    sourceUuid: string,
    targetUuid: string
  ): Promise<EntityEdge[]> {
    return this.getEdgeNamespace(driver).entity.getBetweenNodes(sourceUuid, targetUuid);
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
          return this.getNodeNamespace(driver).episode.getByGroupIds(singleGroupIds, lastN, referenceTime);
        },
        this.max_coroutines
      );
    }
    return this.getNodeNamespace(this.getScopedDriverForGroups(groupIds))
      .episode
      .getByGroupIds(groupIds, lastN, referenceTime);
  }

  async deleteEntityEdge(uuid: string): Promise<void> {
    await this.edges.entity.deleteByUuid(uuid);
  }

  /**
   * Mark a single entity edge as deprecated (soft-delete).
   *
   * Idempotent: if the edge already has both `invalid_at` and `expired_at`
   * set, this method returns without touching the database.
   *
   * @param edgeUuid - UUID of the edge to deprecate
   * @param options.reason - Human-readable reason stored in attributes
   * @param options.superseded_by - UUID of the edge that replaces this one
   * @param options.deprecated_at - Override the deprecation timestamp (default: now)
   */
  async deprecateEdge(
    edgeUuid: string,
    options?: {
      reason?: string;
      superseded_by?: string;
      deprecated_at?: Date;
    }
  ): Promise<void> {
    const scope = this.tracer.startSpan('deprecate_edge');
    try {
      const edge = await this.edges.entity.getByUuid(edgeUuid);

      // Idempotent: already deprecated
      if (edge.invalid_at && edge.expired_at) {
        return;
      }

      const deprecatedAt = options?.deprecated_at ?? new Date();
      edge.invalid_at = deprecatedAt;
      edge.expired_at = deprecatedAt;

      if (options?.reason !== undefined) {
        edge.deprecation_reason = options.reason;
      }
      if (options?.superseded_by !== undefined) {
        edge.superseded_by = options.superseded_by;
      }

      await this.edges.entity.save(edge);
    } finally {
      scope.close();
    }
  }

  /**
   * Bulk-deprecate entity edges matching a filter.
   *
   * Only edges that are NOT already deprecated (`invalid_at IS NULL`) are
   * affected. Pass `dryRun: true` to count candidates without writing.
   *
   * @returns `{ count }` — number of edges (would-be-)deprecated
   */
  async deprecateEdges(
    filter: {
      entity_name?: string;
      edge_type?: string;
      older_than?: Date;
      group_id?: string;
    },
    options?: {
      reason?: string;
      deprecated_at?: Date;
      dryRun?: boolean;
    }
  ): Promise<{ count: number }> {
    const scope = this.tracer.startSpan('deprecate_edges');
    try {
      const whereClauses: string[] = ['e.invalid_at IS NULL'];
      const params: Record<string, unknown> = {};

      if (filter.entity_name !== undefined) {
        whereClauses.push('(source.name = $entity_name OR target.name = $entity_name)');
        params.entity_name = filter.entity_name;
      }
      if (filter.edge_type !== undefined) {
        whereClauses.push('e.name = $edge_type');
        params.edge_type = filter.edge_type;
      }
      if (filter.older_than !== undefined) {
        whereClauses.push('e.created_at < $older_than');
        params.older_than = filter.older_than;
      }
      if (filter.group_id !== undefined) {
        whereClauses.push('e.group_id = $group_id');
        params.group_id = filter.group_id;
      }

      const whereStr = whereClauses.join(' AND ');

      if (options?.dryRun) {
        const result = await this.driver.executeQuery<{ count: unknown }>(
          `MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
           WHERE ${whereStr}
           RETURN count(e) AS count`,
          { params, routing: 'r' }
        );
        const raw = result.records[0]?.count ?? 0;
        const count =
          typeof raw === 'object' && raw !== null && 'low' in raw
            ? (raw as { low: number }).low
            : (raw as number);
        return { count };
      }

      const deprecatedAt = options?.deprecated_at ?? new Date();
      const setClauses = [
        'e.invalid_at = $deprecated_at',
        'e.expired_at = $deprecated_at',
      ];
      if (options?.reason !== undefined) {
        setClauses.push('e.deprecation_reason = $deprecation_reason');
        params.deprecation_reason = options.reason;
      }
      params.deprecated_at = deprecatedAt;

      const result = await this.driver.executeQuery<{ count: unknown }>(
        `MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
         WHERE ${whereStr}
         SET ${setClauses.join(', ')}
         RETURN count(e) AS count`,
        { params, routing: 'w' }
      );
      const raw = result.records[0]?.count ?? 0;
      const count =
        typeof raw === 'object' && raw !== null && 'low' in raw
          ? (raw as { low: number }).low
          : (raw as number);
      return { count };
    } finally {
      scope.close();
    }
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
    const driver = this.getScopedDriver(groupId);
    await driver.executeQuery(
      `
        MATCH (n)
        WHERE n.group_id = $group_id
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        WITH $group_id AS group_id, nodes
        MATCH ()-[e]->()
        WHERE e.group_id = group_id
        WITH nodes, collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(nodes) + size(edges) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }

  async clear(): Promise<void> {
    await this.driver.executeQuery(
      `
        MATCH (n)
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `
    );
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
        async (driver, singleGroupIds) => {
          return this._buildCommunitiesForGroups(driver, singleGroupIds);
        },
        this.max_coroutines
      );
    }

    return this._buildCommunitiesForGroups(this.getScopedDriverForGroups(groupIds), groupIds);
  }

  private async _buildCommunitiesForGroups(
    driver: GraphDriver,
    groupIds: string[] | null
  ): Promise<{ nodes: import('./domain/nodes').CommunityNode[]; edges: import('./domain/edges').CommunityEdge[] }> {
    await removeCommunities(driver, groupIds);

    const nodes = this.getNodeNamespace(driver);
    const communities = this.getCommunityNamespace(driver);

    const [communityNodes, communityEdges] = await buildCommunitiesOp(
      driver,
      this.llm_client!,
      nodes.entity,
      groupIds,
      this.config.community
    );

    await communities.node.saveBulk(communityNodes);
    await communities.edge.saveBulk(communityEdges);

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

    const driver = this.getScopedDriver(entity.group_id);
    const communities = this.getCommunityNamespace(driver);

    const [nodes, edges] = await updateCommunityOp(
      driver,
      this.llm_client,
      this.embedder,
      communities,
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

    return this._executeSearch(
      this.getScopedDriverForGroups(options.group_ids),
      query,
      config,
      options
    );
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

function isTestRuntime(): boolean {
  try {
    const globalScope = globalThis as Record<string, unknown>;
    const hasTestGlobals =
      typeof globalScope.test === 'function' || typeof globalScope.describe === 'function';
    const hasTestArg =
      typeof Bun !== 'undefined' &&
      Array.isArray(Bun.argv) &&
      Bun.argv.some((arg) => arg === 'test' || String(arg).endsWith('/test'));
    return hasTestGlobals || hasTestArg || process.env.NODE_ENV === 'test';
  } catch {
    return false;
  }
}

function createDefaultLLMClient(): LLMClient | null {
  return !isTestRuntime() && hasOpenAIKey() ? new OpenAIClient() : null;
}

function createDefaultEmbedder(): EmbedderClient | null {
  return !isTestRuntime() && hasOpenAIKey() ? new OpenAIEmbedder() : null;
}

function createDefaultReranker(): CrossEncoderClient | null {
  return !isTestRuntime() && hasOpenAIKey() ? new OpenAIRerankerClient() : null;
}
