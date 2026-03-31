import type { GraphDriver } from '../../contracts';
import type { EpisodicEdge } from '../../domain/edges';

export interface EpisodicEdgeOperations {
  save(driver: GraphDriver, edge: EpisodicEdge): Promise<void>;
  saveBulk(driver: GraphDriver, edges: EpisodicEdge[]): Promise<void>;
  getByUuid(driver: GraphDriver, uuid: string): Promise<EpisodicEdge>;
  getByUuids(driver: GraphDriver, uuids: string[]): Promise<EpisodicEdge[]>;
  deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void>;
  deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void>;
}
