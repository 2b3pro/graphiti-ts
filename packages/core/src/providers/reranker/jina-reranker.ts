/**
 * Jina Reranker client for graphiti-ts.
 *
 * Uses the Jina AI Reranker API (https://api.jina.ai/v1/rerank) with
 * jina-reranker-v3 by default. Purpose-built cross-encoder reranker —
 * more accurate than LLM logprob hacking for relevance scoring.
 *
 * Get your Jina AI API key for free: https://jina.ai/?sui=apikey
 */

import type { CrossEncoderClient } from '../../contracts';

const DEFAULT_MODEL = 'jina-reranker-v3';
const JINA_RERANK_ENDPOINT = 'https://api.jina.ai/v1/rerank';

export interface JinaRerankerOptions {
  /** Jina API key. Falls back to JINA_API_KEY env var. */
  apiKey?: string;
  /** Reranker model. Default: jina-reranker-v3 */
  model?: string;
  /** Max results to return. Default: return all (sorted by relevance). */
  topN?: number;
}

export class JinaRerankerClient implements CrossEncoderClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly topN?: number;

  constructor(options: JinaRerankerOptions = {}) {
    const apiKey = options.apiKey ?? process.env.JINA_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Jina API key required. Set JINA_API_KEY env var or pass apiKey option. ' +
        'Get your key at https://jina.ai/?sui=apikey'
      );
    }
    this.apiKey = apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.topN = options.topN;
  }

  async rank(
    query: string,
    passages: string[]
  ): Promise<Array<[string, number]>> {
    if (passages.length === 0) {
      return [];
    }

    const body: Record<string, unknown> = {
      model: this.model,
      query,
      documents: passages,
      return_documents: false,
    };

    if (this.topN !== undefined) {
      body.top_n = this.topN;
    }

    const response = await fetch(JINA_RERANK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Jina Reranker request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`
      );
    }

    const data = (await response.json()) as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    // Map results back to passages, sorted by relevance descending
    const scored: Array<[string, number]> = data.results.map((r) => [
      passages[r.index] ?? '',
      r.relevance_score,
    ]);

    scored.sort((a, b) => b[1] - a[1]);

    return scored;
  }
}
