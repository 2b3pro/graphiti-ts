import type { EmbedderClient } from '../../contracts';

const DEFAULT_MODEL = 'voyage-3';
const DEFAULT_EMBEDDING_DIM = 1024;
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

export interface VoyageEmbedderConfig {
  embeddingModel?: string;
  embeddingDim?: number;
  apiKey?: string | null;
  apiUrl?: string;
}

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

/**
 * Voyage AI embedder for high-quality retrieval embeddings.
 *
 * Uses Voyage AI's REST API directly (no SDK dependency required).
 * Default model: voyage-3 (1024 dimensions).
 */
export class VoyageEmbedder implements EmbedderClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly embeddingModel: string;
  private readonly embeddingDim: number;

  constructor(config: VoyageEmbedderConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.VOYAGE_API_KEY ?? '';
    this.apiUrl = config.apiUrl ?? VOYAGE_API_URL;
    this.embeddingModel = config.embeddingModel ?? DEFAULT_MODEL;
    this.embeddingDim = config.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  }

  async create(
    inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>
  ): Promise<number[]> {
    const input = typeof inputData === 'string' ? [inputData] : [String(inputData)];
    const response = await this.fetchEmbeddings(input);
    const embedding = response.data[0]?.embedding ?? [];
    return embedding.slice(0, this.embeddingDim);
  }

  async createBatch(inputDataList: string[]): Promise<number[][]> {
    if (inputDataList.length === 0) return [];
    const response = await this.fetchEmbeddings(inputDataList);
    return response.data.map((item) => item.embedding.slice(0, this.embeddingDim));
  }

  private async fetchEmbeddings(input: string[]): Promise<VoyageEmbeddingResponse> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        input,
        model: this.embeddingModel
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Voyage AI API error ${response.status}: ${body}`);
    }

    return (await response.json()) as VoyageEmbeddingResponse;
  }
}
