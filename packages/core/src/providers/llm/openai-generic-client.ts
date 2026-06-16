/**
 * Generic OpenAI-compatible LLM client — port of Python's openai_generic_client.py.
 *
 * Works with any API that follows the OpenAI chat completion spec:
 * LocalAI, vLLM, LiteLLM, text-generation-inference, etc.
 */

import OpenAI from 'openai';
import { resolveModelForPrompt } from '../../config';
import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import {
	cleanInput,
	generateResponse as defaultGenerateResponse,
	estimateTokens,
	type GenerateResponseContext,
	getCacheKey,
	parseJsonResponse,
} from '../../llm/generate-response';
import { getExtractionLanguageInstruction } from '../../llm/language';
import type { Message } from '../../prompts/types';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import { EmptyResponseError, RateLimitError, RefusalError } from '../errors';

const DEFAULT_MODEL = 'gpt-4.1-mini';
const MAX_RETRIES = 4;
const DEFAULT_MAX_TOKENS = 16384;

export interface OpenAIGenericClientOptions {
	config?: Partial<LLMConfig>;
	client?: OpenAI;
	max_tokens?: number;
	structured_output_mode?: 'json_schema' | 'json_object';
}

export class OpenAIGenericClient implements LLMClient {
	readonly model: string;
	readonly small_model: string;
	private readonly client: OpenAI;
	private readonly config: LLMConfig;
	private readonly maxTokens: number;
	private readonly structuredOutputMode: 'json_schema' | 'json_object';
	private tracer: Tracer;

	constructor(options: OpenAIGenericClientOptions = {}) {
		this.config = createLLMConfig(options.config);
		this.model = this.config.model ?? DEFAULT_MODEL;
		this.small_model = this.config.small_model ?? this.model;
		this.maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
		this.structuredOutputMode = options.structured_output_mode ?? 'json_schema';
		this.client =
			options.client ??
			new OpenAI({
				apiKey: this.config.api_key ?? 'not-needed',
				baseURL: this.config.base_url ?? undefined,
				maxRetries: MAX_RETRIES,
			});
		this.tracer = new NoOpTracer();
	}

	setTracer(tracer: Tracer): void {
		this.tracer = tracer;
	}

	async generateText(
		messages: Message[],
		options?: { model_override?: string | null },
	): Promise<string> {
		const scope = this.tracer.startSpan('llm.generate');
		const effectiveModel = options?.model_override ?? this.model;

		try {
			scope.span.addAttributes({
				'llm.provider': 'openai-generic',
				'llm.model': effectiveModel,
				'llm.max_tokens': this.maxTokens,
			});

			let lastError: unknown = null;

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				try {
					const response = await this.client.chat.completions.create({
						model: effectiveModel,
						messages: messages.map((m) => ({
							role: m.role as 'system' | 'user' | 'assistant',
							content: m.content,
						})),
						max_tokens: this.maxTokens,
						temperature: this.config.temperature ?? 0,
						response_format: { type: 'json_object' },
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
					if (error instanceof RefusalError) {
						throw error;
					}

					lastError = error;

					if (attempt < MAX_RETRIES) {
						// Longer backoff for rate limits (gateway overload), shorter for other transient errors
						const isRateLimit =
							error instanceof OpenAI.RateLimitError || error instanceof RateLimitError;
						const baseMs = isRateLimit ? 3000 : 1000;
						const waitMs = baseMs * 2 ** attempt;
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
		context?: GenerateResponseContext,
	): Promise<Record<string, unknown>> {
		if (this.structuredOutputMode === 'json_object' || !options?.response_model) {
			return defaultGenerateResponse(this, messages, options, context);
		}

		try {
			return await this.generateJsonSchemaResponse(messages, options, context ?? {});
		} catch (error) {
			if (!isJsonSchemaUnsupportedError(error)) {
				throw error;
			}
			return defaultGenerateResponse(this, messages, options, context);
		}
	}

	private async generateJsonSchemaResponse(
		messages: Message[],
		options: GenerateResponseOptions,
		context: GenerateResponseContext,
	): Promise<Record<string, unknown>> {
		const processedMessages = messages.map((message) => ({ ...message }));
		const languageInstruction = getExtractionLanguageInstruction(options.group_id);
		if (processedMessages.length > 0 && languageInstruction) {
			const firstMessage = processedMessages[0];
			if (firstMessage) {
				firstMessage.content += languageInstruction;
			}
		}

		for (const message of processedMessages) {
			message.content = cleanInput(message.content);
		}

		const { cache, tokenTracker } = context;
		const routedModel = resolveModelForPrompt(
			context.modelRouting ?? undefined,
			options.prompt_name ?? undefined,
		);
		const effectiveModel =
			routedModel ??
			(options.model_size === 'small' && this.small_model ? this.small_model : this.model);
		const cacheKey = cache ? getCacheKey(processedMessages, effectiveModel) : null;
		if (cacheKey) {
			const cached = cache?.get(cacheKey) ?? null;
			if (cached !== null) {
				return cached;
			}
		}

		const inputTokenEstimate = estimateTokens(
			processedMessages.map((message) => message.content).join(''),
		);
		const responseText = await this.createChatCompletion(processedMessages, effectiveModel, {
			type: 'json_schema',
			json_schema: {
				name: 'structured_response',
				schema: options.response_model ?? { type: 'object' },
			},
		});
		const result = parseJsonResponse(responseText);

		if (tokenTracker && options.prompt_name) {
			tokenTracker.record(options.prompt_name, {
				input_tokens: inputTokenEstimate,
				output_tokens: estimateTokens(responseText),
			});
		}

		if (cacheKey) {
			cache?.set(cacheKey, result);
		}

		return result;
	}

	private async createChatCompletion(
		messages: Message[],
		model: string | null,
		responseFormat: Record<string, unknown>,
	): Promise<string> {
		const response = await this.client.chat.completions.create({
			model: model ?? this.model,
			messages: messages.map((m) => ({
				role: m.role as 'system' | 'user' | 'assistant',
				content: m.content,
			})),
			max_tokens: this.maxTokens,
			temperature: this.config.temperature ?? 0,
			response_format: responseFormat as never,
		});

		const content = response.choices[0]?.message?.content ?? '';
		if (content === '') {
			throw new EmptyResponseError();
		}

		const refusal = (response.choices[0]?.message as { refusal?: string })?.refusal;
		if (refusal) {
			throw new RefusalError(refusal);
		}

		return content;
	}
}

function isJsonSchemaUnsupportedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes('json_schema') &&
		(message.includes('unavailable') ||
			message.includes('unsupported') ||
			message.includes('not support') ||
			message.includes('not supported'))
	);
}
