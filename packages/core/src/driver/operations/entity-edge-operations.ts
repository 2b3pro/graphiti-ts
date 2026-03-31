import type { EmbedderClient, GraphDriver } from '../../contracts';
import type { EntityEdge } from '../../domain/edges';

export interface EntityEdgeOperations {
  save(driver: GraphDriver, edge: EntityEdge): Promise<void>;
  saveBulk(driver: GraphDriver, edges: EntityEdge[]): Promise<void>;
  getByUuid(driver: GraphDriver, uuid: string): Promise<EntityEdge>;
  getByUuids(driver: GraphDriver, uuids: string[]): Promise<EntityEdge[]>;
  getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<EntityEdge[]>;
  getBetweenNodes(
    driver: GraphDriver,
    sourceNodeUuid: string,
    targetNodeUuid: string
  ): Promise<EntityEdge[]>;
  getByNodeUuid(driver: GraphDriver, nodeUuid: string): Promise<EntityEdge[]>;
  deleteByUuid(driver: GraphDriver, uuid: string): Promise<void>;
  deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void>;
  deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void>;
  loadEmbeddings(
    driver: GraphDriver,
    edge: EntityEdge,
    embedder: EmbedderClient
  ): Promise<EntityEdge>;
  loadEmbeddingsBulk(
    driver: GraphDriver,
    edges: EntityEdge[],
    embedder: EmbedderClient
  ): Promise<EntityEdge[]>;
}
