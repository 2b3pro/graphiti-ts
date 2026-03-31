import OpenAI from 'openai';

import type { CrossEncoderClient } from '../../contracts';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import { RateLimitError } from '../errors';

const DEFAULT_RERANKER_MODEL = 'gpt-4.1-nano';
const TRUE_TOKEN_ID = '6432';
const FALSE_TOKEN_ID = '7983';

export interface OpenAIRerankerOptions {
  config?: Partial<LLMConfig>;
  client?: OpenAI;
}

export class OpenAIRerankerClient implements CrossEncoderClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIRerankerOptions = {}) {
    const config = createLLMConfig(options.config);
    this.model = config.model ?? DEFAULT_RERANKER_MODEL;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: config.api_key ?? undefined,
        baseURL: config.base_url ?? undefined
      });
  }

  async rank(query: string, passages: string[]): Promise<Array<[string, number]>> {
    const results = await Promise.all(
      passages.map((passage) => this.scorePassage(query, passage))
    );
    return results.sort((left, right) => right[1] - left[1]);
  }

  private async scorePassage(query: string, passage: string): Promise<[string, number]> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a relevance classifier. Given a query and a passage, respond with "True" if the passage is relevant to the query, or "False" if it is not.'
          },
          {
            role: 'user',
            content: `Query: ${query}\n\nPassage: ${passage}\n\nIs this passage relevant to the query? Respond with True or False.`
          }
        ],
        temperature: 0,
        max_tokens: 1,
        logit_bias: { [TRUE_TOKEN_ID]: 1, [FALSE_TOKEN_ID]: 1 },
        logprobs: true,
        top_logprobs: 2
      });

      const topLogprobs = response.choices[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
      return [passage, extractRelevanceScore(topLogprobs)];
    } catch (error) {
      if (error instanceof OpenAI.RateLimitError) {
        throw new RateLimitError(error.message);
      }

      throw error;
    }
  }
}

interface TopLogprob {
  token: string;
  logprob: number;
}

function extractRelevanceScore(topLogprobs: TopLogprob[]): number {
  if (topLogprobs.length === 0) {
    return 0;
  }

  const first = topLogprobs[0];
  if (!first) {
    return 0;
  }

  const token = first.token.trim().toLowerCase();
  const probability = Math.exp(first.logprob);

  if (token === 'true') {
    return probability;
  }

  if (token === 'false') {
    return 1 - probability;
  }

  return probability;
}
