import {
  GraphProviders,
  type GraphProvider
} from '@graphiti/shared';

import type {
  AsyncDisposableTransaction,
  GraphDriver,
  GraphDriverSession,
  QueryOptions,
  QueryResult
} from '../contracts';

export abstract class BaseGraphDriver implements GraphDriver {
  abstract readonly provider: GraphProvider;
  abstract readonly default_group_id: string;
  protected _database: string;

  protected constructor(database: string) {
    this._database = database;
  }

  get database(): string {
    return this._database;
  }

  abstract executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options?: QueryOptions
  ): Promise<QueryResult<RecordShape>>;

  abstract session(database?: string): Promise<GraphDriverSession> | GraphDriverSession;

  abstract transaction():
    | Promise<AsyncDisposableTransaction>
    | AsyncDisposableTransaction;

  abstract close(): Promise<void>;

  abstract deleteAllIndexes(): Promise<void>;

  abstract buildIndicesAndConstraints(deleteExisting?: boolean): Promise<void>;

  withDatabase(database: string): this {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this)) as this,
      this
    );
    clone._database = database;
    return clone;
  }

  getDefaultGroupId(): string {
    return this.provider === GraphProviders.FALKORDB ? '\\_' : '';
  }
}
