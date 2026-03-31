import type { GraphDriver } from '../../contracts';
import type { NextEpisodeEdge } from '../../domain/edges';

export interface NextEpisodeEdgeOperations {
  save(driver: GraphDriver, edge: NextEpisodeEdge): Promise<void>;
  saveBulk(driver: GraphDriver, edges: NextEpisodeEdge[]): Promise<void>;
  getByUuid(driver: GraphDriver, uuid: string): Promise<NextEpisodeEdge>;
  getByUuids(driver: GraphDriver, uuids: string[]): Promise<NextEpisodeEdge[]>;
  getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<NextEpisodeEdge[]>;
  deleteByUuid(driver: GraphDriver, uuid: string): Promise<void>;
  deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void>;
}
