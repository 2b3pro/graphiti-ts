import type { GraphDriver } from '../../contracts';
import type { CommunityNode, EntityNode, EpisodicNode } from '../../domain/nodes';

export interface GraphMaintenanceOperations {
  clearData(driver: GraphDriver, groupIds?: string[] | null): Promise<void>;
  removeCommunities(driver: GraphDriver): Promise<void>;
  getMentionedNodes(driver: GraphDriver, episodes: EpisodicNode[]): Promise<EntityNode[]>;
  getCommunitiesByNodes(driver: GraphDriver, nodes: EntityNode[]): Promise<CommunityNode[]>;
}
