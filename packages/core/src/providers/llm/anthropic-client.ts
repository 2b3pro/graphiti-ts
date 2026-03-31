import Anthropic from '@anthropic-ai/sdk';

import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import type { Message } from '../../prompts/types';
import { generateResponse, type GenerateResponseContext } from '../../llm/generate-response';
import { EmptyResponseError, RateLimitError } from '../errors';

const DEFAULT_MODEL = 'claude-sonnet-4-6-latest';
const DEFAULT_SMALL_MODEL = 'claude-haiku-4-5-latest';
const MAX_RETRIES = 2;

export interface AnthropicClientOptions {
  config?: Partial<LLMConfig>;
  client?: Anthropic;
}

export class AnthropicClient implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly client: Anthropic;
  private readonly config: LLMConfig;
  private tracer: Tracer;

  constructor(options: AnthropicClientOptions = {}) {
    this.config = createLLMConfig(options.config);
    this.model = this.config.model ?? DEFAULT_MODEL;
    this.small_model = this.config.small_model ?? DEFAULT_SMALL_MODEL;
    this.client =
      options.client ??
      new Anthropic({
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
        'llm.provider': 'anthropic',
        'llm.model': this.model,
        'llm.max_tokens': this.config.max_tokens
      });

      const { system, conversation } = partitionMessages(messages);

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: this.config.max_tokens,
            ...(system ? { system } : {}),
            messages: conversation
          });

          const textBlock = response.content.find(
            (block): block is Anthropic.TextBlock => block.type === 'text'
          );
          const content = textBlock?.text ?? '';

          if (content === '') {
            throw new EmptyResponseError();
          }

          scope.span.setStatus('ok');
          return content;
        } catch (error) {
          if (error instanceof Anthropic.RateLimitError) {
            throw new RateLimitError(error.message);
          }

          if (error instanceof RateLimitError || error instanceof EmptyResponseError) {
            throw error;
          }

          lastError = error;

          if (attempt < MAX_RETRIES) {
            conversation.push({
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

function partitionMessages(
  messages: Message[]
): { system: string | undefined; conversation: Anthropic.MessageParam[] } {
  let system: string | undefined;
  const conversation: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      system = message.content;
    } else {
      conversation.push({
        role: message.role as 'user' | 'assistant',
        content: message.content
      });
    }
  }

  return { system, conversation };
}
