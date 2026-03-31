import type { GraphDriver } from '../../contracts';
import type { EpisodeType, EpisodicNode } from '../../domain/nodes';

export interface EpisodeNodeOperations {
  save(driver: GraphDriver, node: EpisodicNode): Promise<void>;
  saveBulk(driver: GraphDriver, nodes: EpisodicNode[]): Promise<void>;
  getByUuid(driver: GraphDriver, uuid: string): Promise<EpisodicNode>;
  getByUuids(driver: GraphDriver, uuids: string[]): Promise<EpisodicNode[]>;
  getByGroupIds(
    driver: GraphDriver,
    groupIds: string[],
    lastN?: number,
    referenceTime?: Date | null
  ): Promise<EpisodicNode[]>;
  getByEntityNodeUuid(driver: GraphDriver, entityNodeUuid: string): Promise<EpisodicNode[]>;
  retrieveEpisodes(
    driver: GraphDriver,
    referenceTime: Date,
    lastN?: number,
    groupIds?: string[] | null,
    source?: EpisodeType | null
  ): Promise<EpisodicNode[]>;
  deleteByUuid(driver: GraphDriver, uuid: string): Promise<void>;
  deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void>;
  deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void>;
}
