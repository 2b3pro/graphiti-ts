import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GenerativeModel, GenerateContentResult } from '@google/generative-ai';

import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import type { Message } from '../../prompts/types';
import { generateResponse, type GenerateResponseContext } from '../../llm/generate-response';
import { EmptyResponseError, RateLimitError } from '../errors';

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_SMALL_MODEL = 'gemini-3-flash-preview';
const MAX_RETRIES = 2;

export interface GeminiClientOptions {
  config?: Partial<LLMConfig>;
  model?: GenerativeModel;
}

export class GeminiClient implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly generativeModel: GenerativeModel;
  private readonly config: LLMConfig;
  private tracer: Tracer;

  constructor(options: GeminiClientOptions = {}) {
    this.config = createLLMConfig(options.config);
    this.model = this.config.model ?? DEFAULT_MODEL;
    this.small_model = this.config.small_model ?? DEFAULT_SMALL_MODEL;

    if (options.model) {
      this.generativeModel = options.model;
    } else {
      const apiKey = this.config.api_key ?? process.env.GOOGLE_API_KEY ?? '';
      const genAI = new GoogleGenerativeAI(apiKey);
      this.generativeModel = genAI.getGenerativeModel({
        model: this.model,
        generationConfig: {
          temperature: this.config.temperature,
          maxOutputTokens: this.config.max_tokens,
          responseMimeType: 'application/json'
        }
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
        'llm.provider': 'gemini',
        'llm.model': this.model,
        'llm.max_tokens': this.config.max_tokens
      });

      const { systemInstruction, contents } = convertMessages(messages);

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result: GenerateContentResult = await this.generativeModel.generateContent({
            ...(systemInstruction ? { systemInstruction } : {}),
            contents
          });

          const response = result.response;
          const content = response.text();

          if (content === '') {
            throw new EmptyResponseError();
          }

          scope.span.setStatus('ok');
          return content;
        } catch (error) {
          if (isRateLimitError(error)) {
            throw new RateLimitError(String(error));
          }

          if (error instanceof RateLimitError || error instanceof EmptyResponseError) {
            throw error;
          }

          lastError = error;

          if (attempt < MAX_RETRIES) {
            contents.push({
              role: 'user',
              parts: [{ text: `Previous attempt failed with error: ${String(error)}. Please try again.` }]
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

function convertMessages(
  messages: Message[]
): {
  systemInstruction: string | undefined;
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
} {
  let systemInstruction: string | undefined;
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemInstruction = message.content;
    } else {
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      });
    }
  }

  return { systemInstruction, contents };
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('429') || message.includes('rate limit') || message.includes('quota');
  }
  return false;
}
