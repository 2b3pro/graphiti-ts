import type { EmbedderClient, GraphDriver } from '../../contracts';
import type { CommunityNode } from '../../domain/nodes';

export interface CommunityNodeOperations {
  save(driver: GraphDriver, node: CommunityNode): Promise<void>;
  saveBulk(driver: GraphDriver, nodes: CommunityNode[]): Promise<void>;
  getByUuid(driver: GraphDriver, uuid: string): Promise<CommunityNode>;
  getByUuids(driver: GraphDriver, uuids: string[]): Promise<CommunityNode[]>;
  getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<CommunityNode[]>;
  deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void>;
  deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void>;
  loadNameEmbedding(
    driver: GraphDriver,
    node: CommunityNode,
    embedder: EmbedderClient
  ): Promise<CommunityNode>;
}
