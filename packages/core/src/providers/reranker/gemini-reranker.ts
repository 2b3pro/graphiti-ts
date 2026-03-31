import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GenerativeModel } from '@google/generative-ai';

import type { CrossEncoderClient } from '../../contracts';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import { RateLimitError } from '../errors';

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export interface GeminiRerankerOptions {
  config?: Partial<LLMConfig>;
  model?: GenerativeModel;
}

/**
 * Gemini reranker that scores passages on a 0-100 scale via direct LLM scoring.
 *
 * Unlike the OpenAI reranker (which uses logprobs), Gemini's API does not support
 * logprobs, so each passage is scored individually with a numeric relevance prompt.
 */
export class GeminiRerankerClient implements CrossEncoderClient {
  private readonly generativeModel: GenerativeModel;
  private readonly modelName: string;

  constructor(options: GeminiRerankerOptions = {}) {
    const config = createLLMConfig(options.config);
    this.modelName = config.model ?? DEFAULT_MODEL;

    if (options.model) {
      this.generativeModel = options.model;
    } else {
      const apiKey = config.api_key ?? process.env.GOOGLE_API_KEY ?? '';
      const genAI = new GoogleGenerativeAI(apiKey);
      this.generativeModel = genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 3
        },
        systemInstruction:
          'You are an expert at rating passage relevance. Respond with only a number from 0-100.'
      });
    }
  }

  async rank(query: string, passages: string[]): Promise<Array<[string, number]>> {
    if (passages.length <= 1) {
      return passages.map((p) => [p, 1.0]);
    }

    try {
      const results = await Promise.all(
        passages.map((passage) => this.scorePassage(query, passage))
      );
      return results.sort((a, b) => b[1] - a[1]);
    } catch (error) {
      if (isRateLimitError(error)) {
        throw new RateLimitError(String(error));
      }
      throw error;
    }
  }

  private async scorePassage(query: string, passage: string): Promise<[string, number]> {
    const prompt = `Rate how well this passage answers or relates to the query. Use a scale from 0 to 100.

Query: ${query}

Passage: ${passage}

Provide only a number between 0 and 100 (no explanation, just the number):`;

    try {
      const result = await this.generativeModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });

      const text = result.response.text().trim();
      const match = text.match(/\b(\d{1,3})\b/);

      if (match) {
        const score = Number(match[1]);
        return [passage, Math.max(0, Math.min(1, score / 100))];
      }

      return [passage, 0.0];
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      return [passage, 0.0];
    }
  }
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('resource_exhausted');
  }
  return false;
}
