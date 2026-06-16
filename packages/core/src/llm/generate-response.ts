/**
 * Shared generateResponse() implementation -- wraps generateText() with structured output,
 * language instructions, input cleaning, token tracking, and response caching.
 *
 * Port of Python's LLMClient.generate_response() base class method.
 */

import { createHash } from 'node:crypto';
import type { GraphitiModelRoutingConfig } from '../config';
import { resolveModelForPrompt } from '../config';
import type { GenerateResponseOptions, LLMClient } from '../contracts';
import type { Message } from '../prompts/types';
import type { LLMCache } from './cache';
import { getExtractionLanguageInstruction } from './language';
import type { TokenUsageTracker } from './token-tracker';

const ZERO_WIDTH_CHAR_CODES = new Set([0x200b, 0x200c, 0x200d, 0xfeff, 0x2060]);

/**
 * Clean input string of invalid unicode and control characters.
 * Port of Python's LLMClient._clean_input().
 */
export function cleanInput(text: string): string {
	return Array.from(text)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return !ZERO_WIDTH_CHAR_CODES.has(code) && !isStrippedControlCode(code);
		})
		.join('');
}

function isStrippedControlCode(code: number): boolean {
	return (
		(code >= 0x00 && code <= 0x08) ||
		code === 0x0b ||
		code === 0x0c ||
		(code >= 0x0e && code <= 0x1f) ||
		code === 0x7f
	);
}

/**
 * Extended options for generateResponse that includes token tracking and caching.
 */
export interface GenerateResponseContext {
	/** Token usage tracker instance for recording per-prompt usage. */
	tokenTracker?: TokenUsageTracker | null;
	/** LLM response cache for avoiding duplicate calls. */
	cache?: LLMCache | null;
	/** Model routing config from GraphitiConfig — enables per-prompt model selection. */
	modelRouting?: GraphitiModelRoutingConfig | null;
}

/**
 * Generate a cache key from messages and model name.
 * Port of Python's LLMClient._get_cache_key().
 */
export function getCacheKey(messages: Message[], model: string | null): string {
	const messageStr = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
	const keyStr = `${model ?? 'unknown'}:${messageStr}`;
	return createHash('md5').update(keyStr).digest('hex');
}

/**
 * Estimate token count from text. Rough approximation: ~4 chars per token.
 * Used when the provider doesn't return exact token counts.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function parseJsonResponse(responseText: string): Record<string, unknown> {
	try {
		// Try to extract JSON from the response (handles markdown code blocks)
		const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
		const jsonText = jsonMatch?.[1]?.trim() ?? responseText.trim();
		return JSON.parse(jsonText) as Record<string, unknown>;
	} catch {
		// If JSON parsing fails, try to find a JSON object in the response
		const objectMatch = responseText.match(/\{[\s\S]*\}/);
		if (objectMatch) {
			try {
				return JSON.parse(objectMatch[0]) as Record<string, unknown>;
			} catch {
				throw new Error(
					`Failed to parse LLM response as JSON. Raw output (first 500 chars): ${responseText.slice(0, 500)}`,
				);
			}
		}

		throw new Error(
			`Failed to parse LLM response as JSON. Raw output (first 500 chars): ${responseText.slice(0, 500)}`,
		);
	}
}

/**
 * Default implementation of generateResponse() that wraps generateText().
 * This is called by all LLM client implementations.
 *
 * Now supports optional token tracking (via prompt_name) and response caching.
 */
export async function generateResponse(
	client: LLMClient,
	messages: Message[],
	options: GenerateResponseOptions = {},
	context: GenerateResponseContext = {},
): Promise<Record<string, unknown>> {
	// Deep clone messages to avoid mutating the caller's array
	const processedMessages = messages.map((m) => ({ ...m }));

	// Append JSON schema to last user message if response_model provided
	if (options.response_model) {
		const serializedModel = JSON.stringify(options.response_model);
		const lastMessage = processedMessages[processedMessages.length - 1];
		if (lastMessage) {
			lastMessage.content += `\n\nRespond with a JSON object in the following format:\n\n${serializedModel}`;
		}
	}

	// Add multilingual extraction instructions to system message
	const languageInstruction = getExtractionLanguageInstruction(options.group_id);
	if (processedMessages.length > 0 && languageInstruction) {
		const firstMessage = processedMessages[0];
		if (firstMessage) {
			firstMessage.content += languageInstruction;
		}
	}

	// Clean all message inputs
	for (const message of processedMessages) {
		message.content = cleanInput(message.content);
	}

	// Check cache first
	const { cache, tokenTracker } = context;
	let cacheKey: string | null = null;

	if (cache) {
		cacheKey = getCacheKey(processedMessages, client.model);
		const cached = cache.get(cacheKey);
		if (cached !== null) {
			return cached;
		}
	}

	// Estimate input tokens before the call
	const inputText = processedMessages.map((m) => m.content).join('');
	const inputTokenEstimate = estimateTokens(inputText);

	// Select model: routing config → model_size fallback → client.model default
	const routedModel = resolveModelForPrompt(
		context.modelRouting ?? undefined,
		options.prompt_name ?? undefined,
	);
	const modelOverride =
		routedModel ??
		(options.model_size === 'small' && client.small_model ? client.small_model : null);

	// Generate text response
	const responseText = await client.generateText(processedMessages, {
		model_override: modelOverride,
	});

	// Track token usage if tracker and prompt_name are available
	if (tokenTracker && options.prompt_name) {
		const outputTokenEstimate = estimateTokens(responseText);
		tokenTracker.record(options.prompt_name, {
			input_tokens: inputTokenEstimate,
			output_tokens: outputTokenEstimate,
		});
	}

	const result = parseJsonResponse(responseText);

	// Cache the response
	if (cache && cacheKey) {
		cache.set(cacheKey, result);
	}

	return result;
}
