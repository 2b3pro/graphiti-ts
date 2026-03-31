import type { GraphDriver } from '../../contracts';
import type { CommunityEdge } from '../../domain/edges';

export interface CommunityEdgeOperations {
  save(driver: GraphDriver, edge: CommunityEdge): Promise<void>;
  saveBulk(driver: GraphDriver, edges: CommunityEdge[]): Promise<void>;
  getByUuid(driver: GraphDriver, uuid: string): Promise<CommunityEdge>;
  getByUuids(driver: GraphDriver, uuids: string[]): Promise<CommunityEdge[]>;
  deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void>;
}
