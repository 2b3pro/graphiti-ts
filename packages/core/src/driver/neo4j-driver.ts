import { GraphProviders } from '@graphiti/shared';
import neo4j, {
  auth as neo4jAuth,
  routing as neo4jRouting,
  type Driver as OfficialNeo4jDriver,
  type EagerResult,
  type QueryResult as OfficialQueryResult,
  type Session as OfficialSession,
  type Transaction as OfficialTransaction
} from 'neo4j-driver';

import type {
  AsyncDisposableTransaction,
  GraphDriverSession,
  QueryOptions,
  QueryResult
} from '../contracts';
import { BaseGraphDriver } from './graph-driver';
import { Neo4jEntityEdgeOperations } from './neo4j/neo4j-entity-edge-operations';
import { Neo4jEntityNodeOperations } from './neo4j/neo4j-entity-node-operations';
import { Neo4jEpisodeNodeOperations } from './neo4j/neo4j-episode-node-operations';
import { Neo4jEpisodicEdgeOperations } from './neo4j/neo4j-episodic-edge-operations';
import { Neo4jCommunityEdgeOperations } from './neo4j/neo4j-community-edge-operations';
import { Neo4jCommunityNodeOperations } from './neo4j/neo4j-community-node-operations';
import { Neo4jSearchOperations } from './neo4j/neo4j-search-operations';
import { Neo4jSagaNodeOperations } from './neo4j/neo4j-saga-node-operations';
import { Neo4jHasEpisodeEdgeOperations } from './neo4j/neo4j-has-episode-edge-operations';
import { Neo4jNextEpisodeEdgeOperations } from './neo4j/neo4j-next-episode-edge-operations';
import { Neo4jGraphMaintenanceOperations } from './neo4j/neo4j-graph-maintenance-operations';
import type { CommunityEdgeOperations } from './operations/community-edge-operations';
import type { CommunityNodeOperations } from './operations/community-node-operations';
import type { EntityEdgeOperations } from './operations/entity-edge-operations';
import type { EntityNodeOperations } from './operations/entity-node-operations';
import type { EpisodeNodeOperations } from './operations/episode-node-operations';
import type { EpisodicEdgeOperations } from './operations/episodic-edge-operations';
import type { SagaNodeOperations } from './operations/saga-node-operations';
import type { HasEpisodeEdgeOperations } from './operations/has-episode-edge-operations';
import type { NextEpisodeEdgeOperations } from './operations/next-episode-edge-operations';
import type { GraphMaintenanceOperations } from './operations/graph-maintenance-operations';
import type { SearchOperations } from './operations/search-operations';

export interface Neo4jConnectionConfig {
  uri: string;
  user: string | null;
  password: string | null;
  database?: string;
}

export interface Neo4jClientAdapter {
  executeQuery<RecordShape = unknown>(
    query: string,
    options: {
      parameters: Record<string, unknown>;
      database: string;
      routing?: 'r' | 'w';
    }
  ): Promise<QueryResult<RecordShape>>;
  session(database: string): GraphDriverSession;
  close(): Promise<void>;
  verifyConnectivity?(): Promise<void>;
}

export interface Neo4jOperationsRegistry {
  entity_node_ops?: EntityNodeOperations;
  episode_node_ops?: EpisodeNodeOperations;
  community_node_ops?: CommunityNodeOperations;
  saga_node_ops?: SagaNodeOperations;
  entity_edge_ops?: EntityEdgeOperations;
  episodic_edge_ops?: EpisodicEdgeOperations;
  community_edge_ops?: CommunityEdgeOperations;
  has_episode_edge_ops?: HasEpisodeEdgeOperations;
  next_episode_edge_ops?: NextEpisodeEdgeOperations;
  search_ops?: SearchOperations;
  graph_ops?: GraphMaintenanceOperations;
}

export class Neo4jDriver extends BaseGraphDriver {
  readonly provider = GraphProviders.NEO4J;
  readonly default_group_id = '';
  readonly config: Neo4jConnectionConfig;
  readonly client: Neo4jClientAdapter;
  readonly operations: Neo4jOperationsRegistry;
  readonly entityNodeOps: EntityNodeOperations;
  readonly episodeNodeOps: EpisodeNodeOperations;
  readonly communityNodeOps: CommunityNodeOperations;
  readonly communityEdgeOps: CommunityEdgeOperations;
  readonly entityEdgeOps: EntityEdgeOperations;
  readonly episodicEdgeOps: EpisodicEdgeOperations;
  readonly sagaNodeOps: SagaNodeOperations;
  readonly hasEpisodeEdgeOps: HasEpisodeEdgeOperations;
  readonly nextEpisodeEdgeOps: NextEpisodeEdgeOperations;
  readonly graphOps: GraphMaintenanceOperations;
  readonly searchOps: SearchOperations;

  constructor(
    config: Neo4jConnectionConfig,
    client: Neo4jClientAdapter,
    operations: Neo4jOperationsRegistry = {}
  ) {
    super(config.database ?? 'neo4j');
    this.config = {
      ...config,
      database: config.database ?? 'neo4j'
    };
    this.client = client;
    this.operations = operations;
    this.entityNodeOps = operations.entity_node_ops ?? new Neo4jEntityNodeOperations();
    this.episodeNodeOps = operations.episode_node_ops ?? new Neo4jEpisodeNodeOperations();
    this.communityNodeOps = operations.community_node_ops ?? new Neo4jCommunityNodeOperations();
    this.communityEdgeOps = operations.community_edge_ops ?? new Neo4jCommunityEdgeOperations();
    this.entityEdgeOps = operations.entity_edge_ops ?? new Neo4jEntityEdgeOperations();
    this.episodicEdgeOps = operations.episodic_edge_ops ?? new Neo4jEpisodicEdgeOperations();
    this.sagaNodeOps = operations.saga_node_ops ?? new Neo4jSagaNodeOperations();
    this.hasEpisodeEdgeOps = operations.has_episode_edge_ops ?? new Neo4jHasEpisodeEdgeOperations();
    this.nextEpisodeEdgeOps = operations.next_episode_edge_ops ?? new Neo4jNextEpisodeEdgeOperations();
    this.graphOps = operations.graph_ops ?? new Neo4jGraphMaintenanceOperations();
    this.searchOps = operations.search_ops ?? new Neo4jSearchOperations();
  }

  async executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<RecordShape>> {
    const parameters = options.params ?? {};
    const database = options.database ?? this.database;
    const executionOptions: {
      parameters: Record<string, unknown>;
      database: string;
      routing?: 'r' | 'w';
    } = {
      parameters,
      database
    };

    if (options.routing) {
      executionOptions.routing = options.routing;
    }

    return this.client.executeQuery<RecordShape>(cypherQuery, executionOptions);
  }

  session(database?: string): GraphDriverSession {
    return this.client.session(database ?? this.database);
  }

  async transaction(): Promise<AsyncDisposableTransaction> {
    const session = this.client.session(this.database);

    if (session instanceof Neo4jSessionAdapter) {
      return session.beginTransaction();
    }

    return new SessionBackedTransaction(session);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async deleteAllIndexes(): Promise<void> {
    const result = await this.executeQuery<{ name: string }>(
      'SHOW INDEXES YIELD name RETURN name',
      { routing: 'r' }
    );

    for (const record of result.records) {
      const recordWithGetter = record as { get?: (key: string) => unknown };
      const name =
        typeof recordWithGetter.get === 'function'
          ? (recordWithGetter.get('name') as string)
          : ((record as { name?: string }).name ?? '');

      if (name) {
        await this.executeQuery(`DROP INDEX ${name}`);
      }
    }
  }

  async buildIndicesAndConstraints(deleteExisting = false): Promise<void> {
    if (deleteExisting) {
      await this.deleteAllIndexes();
    }

    const queries = [
      'CREATE CONSTRAINT entity_uuid IF NOT EXISTS FOR (n:Entity) REQUIRE n.uuid IS UNIQUE',
      'CREATE CONSTRAINT episodic_uuid IF NOT EXISTS FOR (n:Episodic) REQUIRE n.uuid IS UNIQUE',
      'CREATE INDEX entity_group_id IF NOT EXISTS FOR (n:Entity) ON (n.group_id)',
      'CREATE INDEX episodic_group_id IF NOT EXISTS FOR (n:Episodic) ON (n.group_id)',
      'CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name)',
      'CREATE INDEX episodic_name IF NOT EXISTS FOR (n:Episodic) ON (n.name)',
      'CREATE INDEX entity_edge_uuid IF NOT EXISTS FOR ()-[e:RELATES_TO]-() ON (e.uuid)',
      'CREATE INDEX episodic_edge_uuid IF NOT EXISTS FOR ()-[e:MENTIONS]-() ON (e.uuid)'
    ];

    for (const query of queries) {
      await this.executeQuery(query);
    }
  }

  async healthCheck(): Promise<void> {
    if (this.client.verifyConnectivity) {
      await this.client.verifyConnectivity();
    }
  }
}

class SessionBackedTransaction implements AsyncDisposableTransaction {
  private readonly session: GraphDriverSession;

  constructor(session: GraphDriverSession) {
    this.session = session;
  }

  async run<RecordShape = unknown>(
    query: string,
    params: Record<string, unknown> = {}
  ): Promise<QueryResult<RecordShape>> {
    return this.session.executeQuery<RecordShape>(query, { params });
  }

  async commit(): Promise<void> {
    await this.session.close();
  }

  async rollback(): Promise<void> {
    await this.session.close();
  }
}

export function createNeo4jClientAdapter(
  config: Neo4jConnectionConfig
): Neo4jClientAdapter {
  const driver = neo4j.driver(
    config.uri,
    neo4jAuth.basic(config.user ?? '', config.password ?? '')
  );

  return new OfficialNeo4jClientAdapter(driver);
}

class OfficialNeo4jClientAdapter implements Neo4jClientAdapter {
  private readonly driver: OfficialNeo4jDriver;

  constructor(driver: OfficialNeo4jDriver) {
    this.driver = driver;
  }

  async executeQuery<RecordShape = unknown>(
    query: string,
    options: {
      parameters: Record<string, unknown>;
      database: string;
      routing?: 'r' | 'w';
    }
  ): Promise<QueryResult<RecordShape>> {
    const result = await this.driver.executeQuery<EagerResult>(
      query,
      options.parameters,
      {
        database: options.database,
        routing:
          options.routing === 'r' ? neo4jRouting.READ : neo4jRouting.WRITE
      }
    );

    return normalizeEagerResult<RecordShape>(result);
  }

  session(database: string): GraphDriverSession {
    return new Neo4jSessionAdapter(this.driver.session({ database }));
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity();
  }
}

class Neo4jSessionAdapter implements GraphDriverSession {
  private readonly session: OfficialSession;

  constructor(session: OfficialSession) {
    this.session = session;
  }

  async executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options: QueryOptions = {}
  ): Promise<QueryResult<RecordShape>> {
    const result = await this.session.run<Record<string, unknown>>(
      cypherQuery,
      options.params ?? {}
    );

    return normalizeSessionResult<RecordShape>(result);
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async beginTransaction(): Promise<AsyncDisposableTransaction> {
    const transaction = await this.session.beginTransaction();
    return new Neo4jTransactionAdapter(transaction, this.session);
  }
}

class Neo4jTransactionAdapter implements AsyncDisposableTransaction {
  private readonly transaction: OfficialTransaction;
  private readonly session: OfficialSession;

  constructor(transaction: OfficialTransaction, session: OfficialSession) {
    this.transaction = transaction;
    this.session = session;
  }

  async run<RecordShape = unknown>(
    query: string,
    params: Record<string, unknown> = {}
  ): Promise<QueryResult<RecordShape>> {
    const result = await this.transaction.run<Record<string, unknown>>(query, params);
    return normalizeSessionResult<RecordShape>(result);
  }

  async commit(): Promise<void> {
    try {
      await this.transaction.commit();
    } finally {
      await this.session.close();
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.transaction.rollback();
    } finally {
      await this.session.close();
    }
  }
}

function normalizeNeo4jValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'low' in value && 'high' in value) {
    const neo4jInt = value as { low: number; high: number; toNumber?: () => number };
    return typeof neo4jInt.toNumber === 'function' ? neo4jInt.toNumber() : neo4jInt.low;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeNeo4jValue);
  }

  if (typeof value === 'string' && value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
      try {
        return JSON.parse(value);
      } catch {
        // Not valid JSON — return as string
      }
    }
  }

  return value;
}

function recordToPlainObject(record: unknown): Record<string, unknown> {
  const rec = record as { keys?: string[]; get?: (key: string) => unknown; _fields?: unknown[]; _fieldLookup?: Record<string, number> };

  if (rec.keys && typeof rec.get === 'function') {
    const obj: Record<string, unknown> = {};
    for (const key of rec.keys) {
      obj[key] = normalizeNeo4jValue(rec.get(key));
    }
    return obj;
  }

  if (rec._fields && rec._fieldLookup) {
    const obj: Record<string, unknown> = {};
    for (const [key, index] of Object.entries(rec._fieldLookup)) {
      obj[key] = normalizeNeo4jValue(rec._fields[index]);
    }
    return obj;
  }

  return record as Record<string, unknown>;
}

function normalizeEagerResult<RecordShape>(
  result: EagerResult
): QueryResult<RecordShape> {
  return {
    records: result.records.map((record) => recordToPlainObject(record)) as RecordShape[],
    summary: result.summary,
    keys: result.keys
  };
}

function normalizeSessionResult<RecordShape>(
  result: OfficialQueryResult<Record<string, unknown>>
): QueryResult<RecordShape> {
  return {
    records: result.records.map((record) => recordToPlainObject(record)) as RecordShape[],
    summary: result.summary
  };
}
