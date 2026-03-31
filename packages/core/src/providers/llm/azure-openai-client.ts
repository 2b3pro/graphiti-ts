import OpenAI, { AzureOpenAI } from 'openai';

import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import type { Message } from '../../prompts/types';
import { generateResponse, type GenerateResponseContext } from '../../llm/generate-response';
import { EmptyResponseError, RateLimitError } from '../errors';

const MAX_RETRIES = 2;

export interface AzureOpenAIClientOptions {
  config?: Partial<LLMConfig>;
  /** Pre-configured AzureOpenAI or OpenAI client pointing to an Azure endpoint. */
  client?: AzureOpenAI | OpenAI;
  /** Azure API version (e.g. '2024-10-21'). Required if no client is provided. */
  apiVersion?: string;
  /** Azure endpoint (e.g. 'https://my-resource.openai.azure.com'). Required if no client is provided. */
  azureEndpoint?: string;
}

/**
 * Azure OpenAI LLM client.
 *
 * Wraps the OpenAI SDK's AzureOpenAI constructor for enterprise deployments
 * with private endpoints, data residency, and Azure AD authentication.
 * The `model` field maps to your Azure deployment name.
 */
export class AzureOpenAIClient implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly client: AzureOpenAI | OpenAI;
  private readonly config: LLMConfig;
  private tracer: Tracer;

  constructor(options: AzureOpenAIClientOptions = {}) {
    this.config = createLLMConfig(options.config);
    this.model = this.config.model ?? 'gpt-4o';
    this.small_model = this.config.small_model ?? 'gpt-4o-mini';

    if (options.client) {
      this.client = options.client;
    } else {
      this.client = new AzureOpenAI({
        apiKey: this.config.api_key ?? process.env.AZURE_OPENAI_API_KEY ?? undefined,
        apiVersion: options.apiVersion ?? '2024-10-21',
        endpoint: options.azureEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? undefined,
        maxRetries: MAX_RETRIES
      });
    }

    this.tracer = new NoOpTracer();
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  async generateText(messages: Message[]): Promise<string> {
    const scope = this.tracer.startSpan('llm.generate');

    try {
      scope.span.addAttributes({
        'llm.provider': 'azure-openai',
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
