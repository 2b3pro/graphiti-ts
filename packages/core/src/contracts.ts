import type { Tracer } from './tracing';
import type { Message } from './prompts/types';

export interface QueryResult<RecordShape = unknown> {
  records: RecordShape[];
  summary?: unknown;
  keys?: string[];
}

export interface QueryExecutor {
  executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options?: QueryOptions
  ): Promise<QueryResult<RecordShape>>;
}

export interface Transaction {
  run<RecordShape = unknown>(
    query: string,
    params?: Record<string, unknown>
  ): Promise<QueryResult<RecordShape>>;
}

export interface GraphDriverSession extends QueryExecutor {
  close(): Promise<void>;
}

export interface GraphDriver extends QueryExecutor {
  readonly provider: string;
  readonly default_group_id: string;
  readonly database: string;
  session(database?: string): Promise<GraphDriverSession> | GraphDriverSession;
  transaction(): Promise<AsyncDisposableTransaction> | AsyncDisposableTransaction;
  close(): Promise<void>;
  deleteAllIndexes(): Promise<void>;
  buildIndicesAndConstraints(deleteExisting?: boolean): Promise<void>;
}

export interface AsyncDisposableTransaction extends Transaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GenerateResponseOptions {
  /** JSON schema to append to the prompt for structured output */
  response_model?: Record<string, unknown> | null;
  /** Override max tokens for this call */
  max_tokens?: number | null;
  /** Which model size to use (small or medium) */
  model_size?: import('./llm/config').ModelSize;
  /** Group ID for multilingual language instructions */
  group_id?: string | null;
  /** Prompt name for token tracking */
  prompt_name?: string | null;
}

export interface LLMClient {
  readonly model: string | null;
  readonly small_model: string | null;
  setTracer(tracer: Tracer): void;
  /**
   * Low-level text generation — returns raw string.
   * Callers must parse JSON themselves.
   */
  generateText(messages: Message[]): Promise<string>;
  /**
   * Structured response generation — port of Python's generate_response().
   * Appends JSON schema to prompt, adds language instructions, cleans input,
   * and returns parsed JSON object.
   *
   * If not implemented by a provider, the default implementation wraps
   * generateText() with JSON parsing.
   *
   * @param context - Optional context for token tracking and response caching.
   */
  generateResponse?(
    messages: Message[],
    options?: GenerateResponseOptions,
    context?: import('./llm/generate-response').GenerateResponseContext
  ): Promise<Record<string, unknown>>;
}

export interface EmbedderClient {
  create(inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>): Promise<number[]>;
  createBatch?(inputDataList: string[]): Promise<number[][]>;
}

export interface CrossEncoderClient {
  rank(query: string, passages: string[]): Promise<Array<[string, number]>>;
}

export interface GraphitiClients {
  driver: GraphDriver;
  llm_client: LLMClient;
  embedder: EmbedderClient;
  cross_encoder: CrossEncoderClient;
  tracer: Tracer;
  /** Token usage tracker for recording per-prompt usage. */
  tokenTracker?: import('./llm/token-tracker').TokenUsageTracker | null;
  /** LLM response cache for deduplicating calls. */
  cache?: import('./llm/cache').LLMCache | null;
}

export interface QueryOptions {
  params?: Record<string, unknown>;
  routing?: 'r' | 'w';
  database?: string;
}
