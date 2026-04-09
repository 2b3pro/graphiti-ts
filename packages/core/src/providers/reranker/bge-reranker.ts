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

    // BGE/TEI rerankers enforce a max batch size (typically 32).
    // Split into chunks and merge results.
    const BATCH_SIZE = 32;
    const allScored: Array<[string, number]> = [];

    for (let offset = 0; offset < passages.length; offset += BATCH_SIZE) {
      const batch = passages.slice(offset, offset + BATCH_SIZE);

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          texts: batch,
          model: this.model
        })
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`BGE Reranker request failed: ${response.status} ${response.statusText} — ${errorBody}`);
      }

      const raw = await response.json();

      // Handle both formats:
      // - TEI (text-embeddings-inference): flat array [{index, score}]
      // - Wrapped format: {results: [{index, score}]}
      const items: Array<{ index: number; score: number }> = Array.isArray(raw)
        ? raw
        : (raw as { results?: Array<{ index: number; score: number }> }).results ?? [];

      // Map batch-local indices back to the original passage text
      for (const r of items) {
        allScored.push([batch[r.index] ?? '', r.score]);
      }
    }

    allScored.sort((a, b) => b[1] - a[1]);
    return allScored;
  }
}
