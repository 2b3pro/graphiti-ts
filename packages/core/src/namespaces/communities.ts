import { NodeNotFoundError, EdgeNotFoundError, validateGroupId } from '@graphiti/shared';

import type { EmbedderClient, GraphDriver } from '../contracts';
import type { CommunityNode } from '../domain/nodes';
import type { CommunityEdge } from '../domain/edges';
import { getRecordValue, parseDateValue, type RecordLike } from '../utils/records';
import { serializeForCypher } from '../utils/serialization';
import type { CommunityNodeOperations } from '../driver/operations/community-node-operations';
import type { CommunityEdgeOperations } from '../driver/operations/community-edge-operations';
import { FalkorDriver } from '../driver/falkordb-driver';
import { Neo4jDriver } from '../driver/neo4j-driver';

export class CommunityNodeNamespace {
  constructor(
    private readonly driver: GraphDriver,
    private readonly embedder?: EmbedderClient | null,
    private readonly ops?: CommunityNodeOperations
  ) {}

  async save(node: CommunityNode): Promise<CommunityNode> {
    validateGroupId(node.group_id);

    if (!node.name_embedding && this.embedder) {
      node.name_embedding = await this.embedder.create([node.name.replaceAll('\n', ' ')]);
    }

    const ops = this.ops ?? resolveCommunityNodeOps(this.driver);
    if (ops) {
      await ops.save(this.driver, node);
      return node;
    }

    await this.driver.executeQuery(
      `
        MERGE (n:Community {uuid: $node.uuid})
        SET n += $node
        SET n.labels = $labels
        RETURN n.uuid AS uuid
      `,
      {
        params: {
          node: serializeForCypher({
            ...node,
            labels: undefined
          }),
          labels: node.labels
        }
      }
    );

    return node;
  }

  async saveBulk(nodes: CommunityNode[]): Promise<CommunityNode[]> {
    if (nodes.length === 0) return [];

    for (const node of nodes) {
      validateGroupId(node.group_id);
    }

    if (this.embedder) {
      for (const node of nodes) {
        if (!node.name_embedding) {
          node.name_embedding = await this.embedder.create([node.name.replaceAll('\n', ' ')]);
        }
      }
    }

    const ops = this.ops ?? resolveCommunityNodeOps(this.driver);
    if (ops) {
      await ops.saveBulk(this.driver, nodes);
      return nodes;
    }

    for (const node of nodes) {
      await this.save(node);
    }

    return nodes;
  }

  async getByUuid(uuid: string): Promise<CommunityNode> {
    const ops = this.ops ?? resolveCommunityNodeOps(this.driver);
    if (ops) {
      return ops.getByUuid(this.driver, uuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community {uuid: $uuid})
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.summary AS summary,
          n.name_embedding AS name_embedding,
          n.rank AS rank
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new NodeNotFoundError(uuid);
    }

    return mapCommunityNode(record);
  }

  async getByUuids(uuids: string[]): Promise<CommunityNode[]> {
    if (uuids.length === 0) return [];

    const ops = this.ops ?? resolveCommunityNodeOps(this.driver);
    if (ops) {
      return ops.getByUuids(this.driver, uuids);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)
        WHERE n.uuid IN $uuids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.summary AS summary,
          n.name_embedding AS name_embedding,
          n.rank AS rank
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapCommunityNode(record));
  }

  async getByGroupIds(groupIds: string[]): Promise<CommunityNode[]> {
    if (groupIds.length === 0) return [];

    const ops = this.ops ?? resolveCommunityNodeOps(this.driver);
    if (ops) {
      return ops.getByGroupIds(this.driver, groupIds);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)
        WHERE n.group_id IN $group_ids
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.summary AS summary,
          n.name_embedding AS name_embedding,
          n.rank AS rank
      `,
      { params: { group_ids: groupIds }, routing: 'r' }
    );

    return result.records.map((record) => mapCommunityNode(record));
  }

  async deleteByUuids(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    const ops = this.ops ?? resolveCommunityNodeOps(this.driver);
    if (ops) {
      await ops.deleteByUuids(this.driver, uuids);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH (n:Community)
        WHERE n.uuid IN $uuids
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { uuids } }
    );
  }

  async deleteByGroupId(groupId: string): Promise<void> {
    validateGroupId(groupId);

    const ops = this.ops ?? resolveCommunityNodeOps(this.driver);
    if (ops) {
      await ops.deleteByGroupId(this.driver, groupId);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH (n:Community)
        WHERE n.group_id = $group_id
        WITH collect(n) AS nodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN size(nodes) AS deleted_count
      `,
      { params: { group_id: groupId } }
    );
  }
}

export class CommunityEdgeNamespace {
  constructor(
    private readonly driver: GraphDriver,
    private readonly ops?: CommunityEdgeOperations
  ) {}

  async save(edge: CommunityEdge): Promise<CommunityEdge> {
    validateGroupId(edge.group_id);

    const ops = this.ops ?? resolveCommunityEdgeOps(this.driver);
    if (ops) {
      await ops.save(this.driver, edge);
      return edge;
    }

    await this.driver.executeQuery(
      `
        MATCH (community:Community {uuid: $community_uuid})
        MATCH (member {uuid: $member_uuid})
        MERGE (community)-[e:HAS_MEMBER {uuid: $edge.uuid}]->(member)
        SET e += $edge
        RETURN e.uuid AS uuid
      `,
      {
        params: {
          community_uuid: edge.source_node_uuid,
          member_uuid: edge.target_node_uuid,
          edge: serializeForCypher(edge)
        }
      }
    );

    return edge;
  }

  async saveBulk(edges: CommunityEdge[]): Promise<CommunityEdge[]> {
    if (edges.length === 0) return [];

    for (const edge of edges) {
      validateGroupId(edge.group_id);
    }

    const ops = this.ops ?? resolveCommunityEdgeOps(this.driver);
    if (ops) {
      await ops.saveBulk(this.driver, edges);
      return edges;
    }

    for (const edge of edges) {
      await this.save(edge);
    }

    return edges;
  }

  async getByUuid(uuid: string): Promise<CommunityEdge> {
    const ops = this.ops ?? resolveCommunityEdgeOps(this.driver);
    if (ops) {
      return ops.getByUuid(this.driver, uuid);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)-[e:HAS_MEMBER {uuid: $uuid}]->(m)
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.rank AS rank
      `,
      { params: { uuid }, routing: 'r' }
    );

    const record = result.records[0];
    if (!record) {
      throw new EdgeNotFoundError(uuid);
    }

    return mapCommunityEdge(record);
  }

  async getByUuids(uuids: string[]): Promise<CommunityEdge[]> {
    if (uuids.length === 0) return [];

    const ops = this.ops ?? resolveCommunityEdgeOps(this.driver);
    if (ops) {
      return ops.getByUuids(this.driver, uuids);
    }

    const result = await this.driver.executeQuery<RecordLike>(
      `
        MATCH (n:Community)-[e:HAS_MEMBER]->(m)
        WHERE e.uuid IN $uuids
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.rank AS rank
      `,
      { params: { uuids }, routing: 'r' }
    );

    return result.records.map((record) => mapCommunityEdge(record));
  }

  async deleteByUuids(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    const ops = this.ops ?? resolveCommunityEdgeOps(this.driver);
    if (ops) {
      await ops.deleteByUuids(this.driver, uuids);
      return;
    }

    await this.driver.executeQuery(
      `
        MATCH ()-[e:HAS_MEMBER]->()
        WHERE e.uuid IN $uuids
        WITH collect(e) AS edges
        FOREACH (edge IN edges | DELETE edge)
        RETURN size(edges) AS deleted_count
      `,
      { params: { uuids } }
    );
  }
}

export function mapCommunityNode(record: RecordLike): CommunityNode {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    name: getRecordValue<string>(record, 'name') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    labels: (getRecordValue<string[]>(record, 'labels') ?? []).filter((l) => l !== 'Community'),
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    summary: getRecordValue<string>(record, 'summary') ?? '',
    name_embedding: getRecordValue<number[] | null>(record, 'name_embedding') ?? null,
    rank: getRecordValue<number | null>(record, 'rank') ?? null
  };
}

export function mapCommunityEdge(record: RecordLike): CommunityEdge {
  return {
    uuid: getRecordValue<string>(record, 'uuid') ?? '',
    group_id: getRecordValue<string>(record, 'group_id') ?? '',
    source_node_uuid: getRecordValue<string>(record, 'source_node_uuid') ?? '',
    target_node_uuid: getRecordValue<string>(record, 'target_node_uuid') ?? '',
    created_at: parseDateValue(getRecordValue(record, 'created_at')) ?? new Date(),
    rank: getRecordValue<number | null>(record, 'rank') ?? null
  };
}

export interface CommunityNamespaceApi {
  node: CommunityNodeNamespace;
  edge: CommunityEdgeNamespace;
}

export function createCommunityNamespace(
  driver: GraphDriver,
  embedder?: EmbedderClient | null
): CommunityNamespaceApi {
  const nodeOps = resolveCommunityNodeOps(driver);
  const edgeOps = resolveCommunityEdgeOps(driver);
  return {
    node: new CommunityNodeNamespace(driver, embedder, nodeOps),
    edge: new CommunityEdgeNamespace(driver, edgeOps)
  };
}

function resolveCommunityNodeOps(driver: GraphDriver): CommunityNodeOperations | undefined {
  if (driver instanceof Neo4jDriver) {
    return driver.communityNodeOps;
  }

  if (driver instanceof FalkorDriver) {
    return driver.communityNodeOps;
  }

  return undefined;
}

function resolveCommunityEdgeOps(driver: GraphDriver): CommunityEdgeOperations | undefined {
  if (driver instanceof Neo4jDriver) {
    return driver.communityEdgeOps;
  }

  if (driver instanceof FalkorDriver) {
    return driver.communityEdgeOps;
  }

  return undefined;
}
