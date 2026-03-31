import type { GraphDriver } from '../../contracts';
import type { EntityEdge } from '../../domain/edges';
import type { CommunityNode, EntityNode, EpisodicNode } from '../../domain/nodes';
import type { SearchFilters } from '../../search/filters';

export interface SearchOperations {
  nodeSimilaritySearch?(
    driver: GraphDriver,
    queryEmbedding: number[],
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit?: number,
    minScore?: number
  ): Promise<EntityNode[]>;
  edgeSimilaritySearch?(
    driver: GraphDriver,
    queryEmbedding: number[],
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit?: number,
    minScore?: number
  ): Promise<EntityEdge[]>;
  nodeFulltextSearch(
    driver: GraphDriver,
    query: string,
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit?: number
  ): Promise<EntityNode[]>;
  edgeFulltextSearch(
    driver: GraphDriver,
    query: string,
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit?: number
  ): Promise<EntityEdge[]>;
  nodeBfsSearch(
    driver: GraphDriver,
    originNodeUuids: string[] | null | undefined,
    searchFilter: SearchFilters,
    maxDepth?: number,
    groupIds?: string[] | null,
    limit?: number
  ): Promise<EntityNode[]>;
  edgeBfsSearch(
    driver: GraphDriver,
    originNodeUuids: string[] | null | undefined,
    searchFilter: SearchFilters,
    maxDepth?: number,
    groupIds?: string[] | null,
    limit?: number
  ): Promise<EntityEdge[]>;
  nodeDistanceReranker?(
    driver: GraphDriver,
    nodeUuids: string[],
    centerNodeUuid: string,
    minScore?: number
  ): Promise<{ uuids: string[]; scores: number[] }>;
  episodeMentionsReranker?(
    driver: GraphDriver,
    nodeUuids: string[],
    minScore?: number
  ): Promise<{ uuids: string[]; scores: number[] }>;
  episodeFulltextSearch(
    driver: GraphDriver,
    query: string,
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit?: number
  ): Promise<EpisodicNode[]>;
  communityFulltextSearch?(
    driver: GraphDriver,
    query: string,
    groupIds?: string[] | null,
    limit?: number
  ): Promise<CommunityNode[]>;
  communitySimilaritySearch?(
    driver: GraphDriver,
    queryEmbedding: number[],
    groupIds?: string[] | null,
    limit?: number,
    minScore?: number
  ): Promise<CommunityNode[]>;
}
