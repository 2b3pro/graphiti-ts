import type { GraphDriver } from '../../contracts';
import type { SagaNode } from '../../domain/nodes';

export interface SagaNodeOperations {
  save(driver: GraphDriver, node: SagaNode): Promise<void>;
  saveBulk(driver: GraphDriver, nodes: SagaNode[]): Promise<void>;
  getByUuid(driver: GraphDriver, uuid: string): Promise<SagaNode>;
  getByUuids(driver: GraphDriver, uuids: string[]): Promise<SagaNode[]>;
  getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<SagaNode[]>;
  deleteByUuid(driver: GraphDriver, uuid: string): Promise<void>;
  deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void>;
  deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void>;
}
