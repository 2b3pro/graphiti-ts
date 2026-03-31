import OpenAI from 'openai';

import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import type { Message } from '../../prompts/types';
import { generateResponse, type GenerateResponseContext } from '../../llm/generate-response';
import { EmptyResponseError } from '../errors';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_SMALL_MODEL = 'llama3.2';
const MAX_RETRIES = 2;

export interface OllamaClientOptions {
  config?: Partial<LLMConfig>;
  client?: OpenAI;
}

/**
 * Ollama LLM client using the OpenAI-compatible API endpoint.
 *
 * Ollama exposes an OpenAI-compatible REST API at /v1, so this client
 * wraps the OpenAI SDK with Ollama-specific defaults (base URL, API key
 * placeholder, higher max_tokens for local models).
 */
export class OllamaClient implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly client: OpenAI;
  private readonly config: LLMConfig;
  private tracer: Tracer;

  constructor(options: OllamaClientOptions = {}) {
    this.config = createLLMConfig({
      api_key: 'ollama',
      base_url: DEFAULT_BASE_URL,
      max_tokens: 16_384,
      ...options.config
    });
    this.model = this.config.model ?? DEFAULT_MODEL;
    this.small_model = this.config.small_model ?? DEFAULT_SMALL_MODEL;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: this.config.api_key ?? 'ollama',
        baseURL: this.config.base_url ?? DEFAULT_BASE_URL,
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
        'llm.provider': 'ollama',
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
