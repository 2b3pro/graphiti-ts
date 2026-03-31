export type QueryParameters = Record<string, unknown>;

export interface TransactionLike {
  run<RecordShape = unknown>(
    query: string,
    params?: QueryParameters
  ): Promise<RecordShape>;
}

export interface QueryExecutorLike {
  executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    params?: QueryParameters
  ): Promise<RecordShape>;
}
