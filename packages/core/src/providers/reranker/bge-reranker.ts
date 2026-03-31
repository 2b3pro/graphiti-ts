/**
 * BGE Reranker client — port of Python's bge_reranker_client.py.
 *
 * The Python version uses sentence-transformers (native Python). This TS port
 * calls a REST API endpoint that serves a BGE reranker model (e.g., via
 * text-embeddings-inference, FastAPI wrapper, or any compatible service).
 *
 * If no endpoint is available, use the OpenAI or Gemini reranker instead.
 */

import type { CrossEncoderClient } from '../../contracts';

const DEFAULT_ENDPOINT = 'http://localhost:8787/rerank';

export interface BGERerankerOptions {
  endpoint?: string;
  model?: string;
}

export class BGERerankerClient implements CrossEncoderClient {
  private readonly endpoint: string;
  private readonly model: string;

  constructor(options: BGERerankerOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.model = options.model ?? 'BAAI/bge-reranker-v2-m3';
  }

  async rank(
    query: string,
    passages: string[]
  ): Promise<Array<[string, number]>> {
    if (passages.length === 0) {
      return [];
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        texts: passages,
        model: this.model
      })
    });

    if (!response.ok) {
      throw new Error(`BGE Reranker request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      results?: Array<{ index: number; score: number }>;
    };

    // Map results back to passages and sort by score descending
    const scored: Array<[string, number]> = (data.results ?? []).map((r) => [
      passages[r.index] ?? '',
      r.score
    ]);

    scored.sort((a, b) => b[1] - a[1]);

    return scored;
  }
}
