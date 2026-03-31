import {
  DEFAULT_MIN_SCORE,
  DEFAULT_MMR_LAMBDA,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_DEPTH
} from './constants';
import type {
  CommunityNode,
  EntityNode,
  EpisodicNode
} from '../domain/nodes';
import type { EntityEdge } from '../domain/edges';

export const EdgeSearchMethods = {
  cosine_similarity: 'cosine_similarity',
  bm25: 'bm25',
  bfs: 'breadth_first_search'
} as const;

export const NodeSearchMethods = {
  cosine_similarity: 'cosine_similarity',
  bm25: 'bm25',
  bfs: 'breadth_first_search'
} as const;

export const EpisodeSearchMethods = {
  bm25: 'bm25'
} as const;

export const CommunitySearchMethods = {
  cosine_similarity: 'cosine_similarity',
  bm25: 'bm25'
} as const;

export const EdgeRerankers = {
  rrf: 'reciprocal_rank_fusion',
  node_distance: 'node_distance',
  episode_mentions: 'episode_mentions',
  mmr: 'mmr',
  cross_encoder: 'cross_encoder'
} as const;

export const NodeRerankers = {
  rrf: 'reciprocal_rank_fusion',
  node_distance: 'node_distance',
  episode_mentions: 'episode_mentions',
  mmr: 'mmr',
  cross_encoder: 'cross_encoder'
} as const;

export const EpisodeRerankers = {
  rrf: 'reciprocal_rank_fusion',
  cross_encoder: 'cross_encoder'
} as const;

export const CommunityRerankers = {
  rrf: 'reciprocal_rank_fusion',
  mmr: 'mmr',
  cross_encoder: 'cross_encoder'
} as const;

export type EdgeSearchMethod =
  (typeof EdgeSearchMethods)[keyof typeof EdgeSearchMethods];
export type NodeSearchMethod =
  (typeof NodeSearchMethods)[keyof typeof NodeSearchMethods];
export type EpisodeSearchMethod =
  (typeof EpisodeSearchMethods)[keyof typeof EpisodeSearchMethods];
export type CommunitySearchMethod =
  (typeof CommunitySearchMethods)[keyof typeof CommunitySearchMethods];

export type EdgeReranker =
  (typeof EdgeRerankers)[keyof typeof EdgeRerankers];
export type NodeReranker =
  (typeof NodeRerankers)[keyof typeof NodeRerankers];
export type EpisodeReranker =
  (typeof EpisodeRerankers)[keyof typeof EpisodeRerankers];
export type CommunityReranker =
  (typeof CommunityRerankers)[keyof typeof CommunityRerankers];

export interface EdgeSearchConfig {
  search_methods: EdgeSearchMethod[];
  reranker: EdgeReranker;
  sim_min_score: number;
  mmr_lambda: number;
  bfs_max_depth: number;
}

export interface NodeSearchConfig {
  search_methods: NodeSearchMethod[];
  reranker: NodeReranker;
  sim_min_score: number;
  mmr_lambda: number;
  bfs_max_depth: number;
}

export interface EpisodeSearchConfig {
  search_methods: EpisodeSearchMethod[];
  reranker: EpisodeReranker;
  sim_min_score: number;
  mmr_lambda: number;
  bfs_max_depth: number;
}

export interface CommunitySearchConfig {
  search_methods: CommunitySearchMethod[];
  reranker: CommunityReranker;
  sim_min_score: number;
  mmr_lambda: number;
  bfs_max_depth: number;
}

export interface SearchConfig {
  edge_config?: EdgeSearchConfig | null;
  node_config?: NodeSearchConfig | null;
  episode_config?: EpisodeSearchConfig | null;
  community_config?: CommunitySearchConfig | null;
  limit: number;
  reranker_min_score: number;
}

export interface SearchResults {
  edges: EntityEdge[];
  edge_reranker_scores: number[];
  nodes: EntityNode[];
  node_reranker_scores: number[];
  episodes: EpisodicNode[];
  episode_reranker_scores: number[];
  communities: CommunityNode[];
  community_reranker_scores: number[];
}

export function createEdgeSearchConfig(
  overrides: Partial<EdgeSearchConfig> = {}
): EdgeSearchConfig {
  return {
    search_methods: overrides.search_methods ?? [],
    reranker: overrides.reranker ?? EdgeRerankers.rrf,
    sim_min_score: overrides.sim_min_score ?? DEFAULT_MIN_SCORE,
    mmr_lambda: overrides.mmr_lambda ?? DEFAULT_MMR_LAMBDA,
    bfs_max_depth: overrides.bfs_max_depth ?? MAX_SEARCH_DEPTH
  };
}

export function createNodeSearchConfig(
  overrides: Partial<NodeSearchConfig> = {}
): NodeSearchConfig {
  return {
    search_methods: overrides.search_methods ?? [],
    reranker: overrides.reranker ?? NodeRerankers.rrf,
    sim_min_score: overrides.sim_min_score ?? DEFAULT_MIN_SCORE,
    mmr_lambda: overrides.mmr_lambda ?? DEFAULT_MMR_LAMBDA,
    bfs_max_depth: overrides.bfs_max_depth ?? MAX_SEARCH_DEPTH
  };
}

export function createEpisodeSearchConfig(
  overrides: Partial<EpisodeSearchConfig> = {}
): EpisodeSearchConfig {
  return {
    search_methods: overrides.search_methods ?? [],
    reranker: overrides.reranker ?? EpisodeRerankers.rrf,
    sim_min_score: overrides.sim_min_score ?? DEFAULT_MIN_SCORE,
    mmr_lambda: overrides.mmr_lambda ?? DEFAULT_MMR_LAMBDA,
    bfs_max_depth: overrides.bfs_max_depth ?? MAX_SEARCH_DEPTH
  };
}

export function createCommunitySearchConfig(
  overrides: Partial<CommunitySearchConfig> = {}
): CommunitySearchConfig {
  return {
    search_methods: overrides.search_methods ?? [],
    reranker: overrides.reranker ?? CommunityRerankers.rrf,
    sim_min_score: overrides.sim_min_score ?? DEFAULT_MIN_SCORE,
    mmr_lambda: overrides.mmr_lambda ?? DEFAULT_MMR_LAMBDA,
    bfs_max_depth: overrides.bfs_max_depth ?? MAX_SEARCH_DEPTH
  };
}

export function createSearchConfig(
  overrides: Partial<SearchConfig> = {}
): SearchConfig {
  return {
    edge_config: overrides.edge_config ?? null,
    node_config: overrides.node_config ?? null,
    episode_config: overrides.episode_config ?? null,
    community_config: overrides.community_config ?? null,
    limit: overrides.limit ?? DEFAULT_SEARCH_LIMIT,
    reranker_min_score: overrides.reranker_min_score ?? 0
  };
}

export function createSearchResults(
  overrides: Partial<SearchResults> = {}
): SearchResults {
  return {
    edges: overrides.edges ?? [],
    edge_reranker_scores: overrides.edge_reranker_scores ?? [],
    nodes: overrides.nodes ?? [],
    node_reranker_scores: overrides.node_reranker_scores ?? [],
    episodes: overrides.episodes ?? [],
    episode_reranker_scores: overrides.episode_reranker_scores ?? [],
    communities: overrides.communities ?? [],
    community_reranker_scores: overrides.community_reranker_scores ?? []
  };
}

export function mergeSearchResults(resultsList: SearchResults[]): SearchResults {
  const merged = createSearchResults();

  for (const result of resultsList) {
    merged.edges.push(...result.edges);
    merged.edge_reranker_scores.push(...result.edge_reranker_scores);
    merged.nodes.push(...result.nodes);
    merged.node_reranker_scores.push(...result.node_reranker_scores);
    merged.episodes.push(...result.episodes);
    merged.episode_reranker_scores.push(...result.episode_reranker_scores);
    merged.communities.push(...result.communities);
    merged.community_reranker_scores.push(...result.community_reranker_scores);
  }

  return merged;
}
