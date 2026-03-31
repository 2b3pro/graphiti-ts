import OpenAI from 'openai';

import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import type { Message } from '../../prompts/types';
import { generateResponse, type GenerateResponseContext } from '../../llm/generate-response';
import { EmptyResponseError, RateLimitError } from '../errors';

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_SMALL_MODEL = 'llama-3.1-8b-instant';
const DEFAULT_MAX_TOKENS = 2048;
const MAX_RETRIES = 2;

export interface GroqClientOptions {
  config?: Partial<LLMConfig>;
  client?: OpenAI;
}

/**
 * Groq LLM client for ultra-fast inference on open models.
 *
 * Groq's API is OpenAI-compatible, so this wraps the OpenAI SDK with
 * Groq's base URL (https://api.groq.com/openai/v1) and sensible defaults
 * for Groq-hosted models (Llama, Mixtral, etc.).
 */
export class GroqClient implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly client: OpenAI;
  private readonly config: LLMConfig;
  private tracer: Tracer;

  constructor(options: GroqClientOptions = {}) {
    this.config = createLLMConfig({
      base_url: 'https://api.groq.com/openai/v1',
      max_tokens: DEFAULT_MAX_TOKENS,
      ...options.config
    });
    this.model = this.config.model ?? DEFAULT_MODEL;
    this.small_model = this.config.small_model ?? DEFAULT_SMALL_MODEL;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: this.config.api_key ?? process.env.GROQ_API_KEY ?? undefined,
        baseURL: this.config.base_url ?? 'https://api.groq.com/openai/v1',
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
        'llm.provider': 'groq',
        'llm.model': this.model,
        'llm.max_tokens': this.config.max_tokens
      });

      const openaiMessages = messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content
      }));

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await this.client.chat.completions.create({
            model: this.model,
            messages: openaiMessages,
            temperature: this.config.temperature,
            max_tokens: this.config.max_tokens,
            response_format: { type: 'json_object' }
          });

          const content = response.choices[0]?.message?.content ?? '';
          if (content === '') {
            throw new EmptyResponseError();
          }

          scope.span.setStatus('ok');
          return content;
        } catch (error) {
          if (error instanceof OpenAI.RateLimitError) {
            throw new RateLimitError(error.message);
          }
          if (error instanceof EmptyResponseError) throw error;
          lastError = error;
        }
      }

      throw lastError;
    } catch (error) {
      scope.span.setStatus('error', String(error));
      if (error instanceof Error) scope.span.recordException(error);
      throw error;
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
