import { NodeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { GraphDriver } from '../../contracts';
import type { SagaNode } from '../../domain/nodes';
import { getRecordValue, parseDateValue, type RecordLike } from '../../utils/records';
import { serializeForFalkor } from '../../utils/serialization';
import type { SagaNodeOperations } from '../operations/saga-node-operations';

export class FalkorSagaNodeOperations implements SagaNodeOperations {
  async save(driver: GraphDriver, node: SagaNode): Promise<void> {
    validateGroupId(node.group_id);

    await driver.executeQuery(
      `
        MERGE (n:Saga {uuid: $saga.uuid})
        SET n += $saga
        SET n:Saga
        RETURN n.uuid AS uuid
      `,
      { params: { saga: serializeForFalkor(node) } }
    );
  }

  async saveBulk(driver: GraphDriver, nodes: SagaNode[]): Promise<void> {
    if (nodes.length === 0) return;
    for (const node of nodes) {
      await this.save(driver, node);
    }
  }

  async getByUuid(driver: GraphDriver, uuid: string): Promise<SagaNode> {
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (s:Saga {uuid: $uuid})
        RETURN
          s.uuid AS uuid,
          s.name AS name,
          s.group_id AS group_id,
          coalesce(s.labels, labels(s)) AS labels,
          s.created_at AS created_at,
          s.summary AS summary
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new NodeNotFoundError(uuid);
    }

    return mapSagaNode(record);
  }

  async getByUuids(driver: GraphDriver, uuids: string[]): Promise<SagaNode[]> {
    if (uuids.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (s:Saga)
        WHERE s.uuid IN $uuids
        RETURN
          s.uuid AS uuid,
          s.name AS name,
          s.group_id AS group_id,
          coalesce(s.labels, labels(s)) AS labels,
          s.created_at AS created_at,
          s.summary AS summary
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapSagaNode(record));
  }

  async getByGroupIds(driver: GraphDriver, groupIds: string[]): Promise<SagaNode[]> {
    if (groupIds.length === 0) return [];

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (s:Saga)
        WHERE s.group_id IN $group_ids
        RETURN
          s.uuid AS uuid,
          s.name AS name,
          s.group_id AS group_id,
          coalesce(s.labels, labels(s)) AS labels,
          s.created_at AS created_at,
          s.summary AS summary
        ORDER BY s.uuid DESC
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapSagaNode(record));
  }

  async deleteByUuid(driver: GraphDriver, uuid: string): Promise<void> {
    const result = await driver.executeQuery<{ deleted_count: number }>(
      `
        MATCH (n:Saga {uuid: $uuid})
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { uuid } }
    );

    if ((result.records[0]?.deleted_count ?? 0) === 0) {
      throw new NodeNotFoundError(uuid);
    }
  }

  async deleteByUuids(driver: GraphDriver, uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await driver.executeQuery(
      `
        MATCH (n:Saga)
        WHERE n.uuid IN $uuids
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { uuids } }
    );
  }

  async deleteByGroupId(driver: GraphDriver, groupId: string): Promise<void> {
    validateGroupId(groupId);

    await driver.executeQuery(
      `
        MATCH (n:Saga)
        WHERE n.group_id = $group_id
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }
}

function mapSagaNode(record: RecordLike): SagaNode {
  const rawLabels = getRecordValue<string[]>(record, 'labels') ?? [];

  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    name: getRecordValue<string>(record, 'name') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    labels: rawLabels.filter((label) => label !== 'Saga'),
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    summary: getRecordValue<string>(record, 'summary') ?? ''
  };
}
