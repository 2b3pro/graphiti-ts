import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GenerativeModel } from '@google/generative-ai';

import type { EmbedderClient } from '../../contracts';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-004';

export interface GeminiEmbedderConfig {
  embeddingModel?: string;
  apiKey?: string | null;
}

export interface GeminiEmbedderDeps {
  model?: GenerativeModel;
}

export class GeminiEmbedder implements EmbedderClient {
  private readonly generativeModel: GenerativeModel;

  constructor(config: GeminiEmbedderConfig = {}, deps?: GeminiEmbedderDeps) {
    if (deps?.model) {
      this.generativeModel = deps.model;
    } else {
      const apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY ?? '';
      const genAI = new GoogleGenerativeAI(apiKey);
      this.generativeModel = genAI.getGenerativeModel({
        model: config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
      });
    }
  }

  async create(
    inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>
  ): Promise<number[]> {
    const text = normalizeToString(inputData);
    const result = await this.generativeModel.embedContent(text);
    return result.embedding.values;
  }

  async createBatch(inputDataList: string[]): Promise<number[][]> {
    const results = await Promise.all(
      inputDataList.map((text) => this.generativeModel.embedContent(text))
    );
    return results.map((result) => result.embedding.values);
  }
}

function normalizeToString(
  inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>
): string {
  if (typeof inputData === 'string') {
    return inputData;
  }

  if (Array.isArray(inputData) && inputData.length > 0 && typeof inputData[0] === 'string') {
    return inputData[0] as string;
  }

  return String(inputData);
}
