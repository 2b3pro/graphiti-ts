/**
 * Generic OpenAI-compatible LLM client — port of Python's openai_generic_client.py.
 *
 * Works with any API that follows the OpenAI chat completion spec:
 * LocalAI, vLLM, LiteLLM, text-generation-inference, etc.
 */

import OpenAI from 'openai';

import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import type { Message } from '../../prompts/types';
import { generateResponse, type GenerateResponseContext } from '../../llm/generate-response';
import { EmptyResponseError, RateLimitError, RefusalError } from '../errors';

const DEFAULT_MODEL = 'gpt-4.1-mini';
const MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 16384;

export interface OpenAIGenericClientOptions {
  config?: Partial<LLMConfig>;
  client?: OpenAI;
  max_tokens?: number;
}

export class OpenAIGenericClient implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly client: OpenAI;
  private readonly config: LLMConfig;
  private readonly maxTokens: number;
  private tracer: Tracer;

  constructor(options: OpenAIGenericClientOptions = {}) {
    this.config = createLLMConfig(options.config);
    this.model = this.config.model ?? DEFAULT_MODEL;
    this.small_model = this.config.small_model ?? this.model;
    this.maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: this.config.api_key ?? 'not-needed',
        baseURL: this.config.base_url ?? undefined,
        maxRetries: MAX_RETRIES
      });
    this.tracer = new NoOpTracer();
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  async generateText(messages: Message[]): Promise<string> {
    const scope = this.tracer.startSpan('llm.generate');

    try {
      scope.span.addAttributes({
        'llm.provider': 'openai-generic',
        'llm.model': this.model,
        'llm.max_tokens': this.maxTokens
      });

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await this.client.chat.completions.create({
            model: this.model,
            messages: messages.map((m) => ({
              role: m.role as 'system' | 'user' | 'assistant',
              content: m.content
            })),
            max_tokens: this.maxTokens,
            temperature: this.config.temperature ?? 0,
            response_format: { type: 'json_object' }
          });

          let content = response.choices[0]?.message?.content ?? '';

          if (content === '') {
            throw new EmptyResponseError();
          }

          // Strip markdown code fences that some local LLMs wrap around JSON
          if (content.startsWith('```')) {
            content = content.split('\n', 2).slice(1).join('\n');
            content = content.replace(/```\s*$/, '').trim();
          }

          const refusal = (response.choices[0]?.message as { refusal?: string })?.refusal;
          if (refusal) {
            throw new RefusalError(refusal);
          }

          scope.span.setStatus('ok');
          return content;
        } catch (error) {
          if (error instanceof OpenAI.RateLimitError) {
            throw new RateLimitError(error.message);
          }

          if (error instanceof RefusalError || error instanceof RateLimitError) {
            throw error;
          }

          lastError = error;

          if (attempt < MAX_RETRIES) {
            const waitMs = Math.pow(2, attempt) * 1000;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
        }
      }

      scope.span.setStatus('error');
      throw lastError ?? new Error('OpenAI-Generic request failed after retries');
    } finally {
      scope.close();
    }
  }

  async generateResponse(
    messages: Message[],
    options?: GenerateResponseOptions,
    context?: GenerateResponseContext
  ): Promise<Record<string, unknown>> {
    return generateResponse(this, messages, options, context);
  }
}
