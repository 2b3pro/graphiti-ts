import OpenAI from 'openai';

import type { EmbedderClient } from '../../contracts';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_EMBEDDING_DIM = 768;

export interface OllamaEmbedderConfig {
  embeddingModel?: string;
  embeddingDim?: number;
  baseUrl?: string;
}

/**
 * Ollama embedder using the OpenAI-compatible API endpoint.
 *
 * Ollama serves embedding models at /v1/embeddings, compatible with the
 * OpenAI SDK. Default model is nomic-embed-text (768 dimensions).
 */
export class OllamaEmbedder implements EmbedderClient {
  private readonly client: OpenAI;
  private readonly embeddingModel: string;
  private readonly embeddingDim: number;

  constructor(config: OllamaEmbedderConfig = {}, client?: OpenAI) {
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.embeddingDim = config.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
    this.client =
      client ??
      new OpenAI({
        apiKey: 'ollama',
        baseURL: config.baseUrl ?? DEFAULT_BASE_URL
      });
  }

  async create(
    inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>
  ): Promise<number[]> {
    const input = typeof inputData === 'string' ? inputData : String(inputData);
    const response = await this.client.embeddings.create({
      input,
      model: this.embeddingModel
    });
    const embedding = response.data[0]?.embedding ?? [];
    return embedding.slice(0, this.embeddingDim);
  }

  async createBatch(inputDataList: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      input: inputDataList,
      model: this.embeddingModel
    });
    return response.data.map((item) => item.embedding.slice(0, this.embeddingDim));
  }
}
