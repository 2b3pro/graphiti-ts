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
const DEFAULT_SMALL_MODEL = 'gpt-4.1-nano';
const MAX_RETRIES = 2;

const ZERO_WIDTH_CHARS = /[\u200b\u200c\u200d\ufeff\u2060]/g;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function isReasoningModel(model: string): boolean {
  return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3');
}

function cleanInput(text: string): string {
  return text.replace(ZERO_WIDTH_CHARS, '').replace(CONTROL_CHARS, '');
}

export interface OpenAIClientOptions {
  config?: Partial<LLMConfig>;
  client?: OpenAI;
}

export class OpenAIClient implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly client: OpenAI;
  private readonly config: LLMConfig;
  private tracer: Tracer;

  constructor(options: OpenAIClientOptions = {}) {
    this.config = createLLMConfig(options.config);
    this.model = this.config.model ?? DEFAULT_MODEL;
    this.small_model = this.config.small_model ?? DEFAULT_SMALL_MODEL;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: this.config.api_key ?? undefined,
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
        'llm.provider': 'openai',
        'llm.model': this.model,
        'llm.max_tokens': this.config.max_tokens
      });

      const cleanedMessages = messages.map((message) => ({
        role: message.role as 'system' | 'user' | 'assistant',
        content: cleanInput(message.content)
      }));

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const reasoning = isReasoningModel(this.model);
          const response = await this.client.chat.completions.create({
            model: this.model,
            messages: cleanedMessages,
            ...(reasoning ? {} : { temperature: this.config.temperature }),
            max_tokens: reasoning ? null : this.config.max_tokens,
            ...(reasoning ? { max_completion_tokens: this.config.max_tokens } : {}),
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

          if (error instanceof RefusalError || error instanceof RateLimitError) {
            throw error;
          }

          lastError = error;

          if (attempt < MAX_RETRIES) {
            cleanedMessages.push({
              role: 'user',
              content: `Previous attempt failed with error: ${String(error)}. Please try again.`
            });
          }
        }
      }

      throw lastError;
    } catch (error) {
      scope.span.setStatus('error', String(error));

      if (error instanceof Error) {
        scope.span.recordException(error);
      }

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
