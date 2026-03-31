import type OpenAI from 'openai';
import type { AzureOpenAI } from 'openai';

import type { EmbedderClient } from '../../contracts';

const DEFAULT_MODEL = 'text-embedding-3-small';

export interface AzureOpenAIEmbedderOptions {
  /** Pre-configured AzureOpenAI or OpenAI client pointing to an Azure endpoint. */
  client: AzureOpenAI | OpenAI;
  /** Azure deployment name for the embedding model. */
  model?: string;
  /** Truncate embeddings to this dimension. */
  embeddingDim?: number;
}

/**
 * Azure OpenAI embedder for enterprise deployments.
 *
 * Uses a pre-configured AzureOpenAI client (user handles auth and endpoint setup).
 * The `model` field maps to your Azure deployment name for the embedding model.
 */
export class AzureOpenAIEmbedder implements EmbedderClient {
  private readonly client: AzureOpenAI | OpenAI;
  private readonly model: string;
  private readonly embeddingDim: number | null;

  constructor(options: AzureOpenAIEmbedderOptions) {
    this.client = options.client;
    this.model = options.model ?? DEFAULT_MODEL;
    this.embeddingDim = options.embeddingDim ?? null;
  }

  async create(
    inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>
  ): Promise<number[]> {
    const input = typeof inputData === 'string' ? inputData : String(inputData);
    const response = await this.client.embeddings.create({
      input,
      model: this.model
    });
    const embedding = response.data[0]?.embedding ?? [];
    return this.embeddingDim ? embedding.slice(0, this.embeddingDim) : embedding;
  }

  async createBatch(inputDataList: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      input: inputDataList,
      model: this.model
    });
    return response.data.map((item) =>
      this.embeddingDim ? item.embedding.slice(0, this.embeddingDim) : item.embedding
    );
  }
}
