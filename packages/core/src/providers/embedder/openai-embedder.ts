import OpenAI from 'openai';

import type { EmbedderClient } from '../../contracts';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_EMBEDDING_DIM = 1024;

export interface OpenAIEmbedderConfig {
  embeddingModel?: string;
  embeddingDim?: number;
  apiKey?: string | null;
  baseUrl?: string | null;
}

export class OpenAIEmbedder implements EmbedderClient {
  private readonly client: OpenAI;
  private readonly embeddingModel: string;
  private readonly embeddingDim: number;

  constructor(config: OpenAIEmbedderConfig = {}, client?: OpenAI) {
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.embeddingDim = config.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
    this.client =
      client ??
      new OpenAI({
        apiKey: config.apiKey ?? undefined,
        baseURL: config.baseUrl ?? undefined
      });
  }

  async create(
    inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>
  ): Promise<number[]> {
    const input = normalizeInput(inputData);
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

function normalizeInput(
  inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>
): string | string[] {
  if (typeof inputData === 'string') {
    return inputData;
  }

  if (Array.isArray(inputData) && inputData.length > 0 && typeof inputData[0] === 'string') {
    return inputData as string[];
  }

  return String(inputData);
}
