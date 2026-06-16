import { describe, expect, test } from 'bun:test';

import { OpenAIGenericClient, type OpenAIGenericClientOptions } from './openai-generic-client';

type CapturedChatParams = {
	response_format: { type: string; [key: string]: unknown };
	messages: Array<{ content: string }>;
};

type MockOpenAIClient = NonNullable<OpenAIGenericClientOptions['client']>;

function createCapturingOpenAI(
	responseContent: string,
	calls: CapturedChatParams[] = [],
): MockOpenAIClient {
	return {
		chat: {
			completions: {
				create: async (params: CapturedChatParams) => {
					calls.push(params);
					return {
						choices: [{ message: { content: responseContent } }],
					};
				},
			},
		},
	} as unknown as MockOpenAIClient;
}

describe('OpenAIGenericClient', () => {
	test('uses json_schema response format for structured responses by default', async () => {
		const calls: CapturedChatParams[] = [];
		const client = new OpenAIGenericClient({
			client: createCapturingOpenAI('{"ok": true}', calls),
		});

		const result = await client.generateResponse([{ role: 'user', content: 'extract' }], {
			response_model: {
				type: 'object',
				properties: { ok: { type: 'boolean' } },
			},
		});

		expect(result).toEqual({ ok: true });
		const firstCall = calls[0];
		if (!firstCall) throw new Error('expected OpenAI call');
		expect(firstCall.response_format).toEqual({
			type: 'json_schema',
			json_schema: {
				name: 'structured_response',
				schema: {
					type: 'object',
					properties: { ok: { type: 'boolean' } },
				},
			},
		});
		const firstMessage = firstCall.messages[0];
		if (!firstMessage) throw new Error('expected OpenAI message');
		expect(firstMessage.content).not.toContain(
			'Respond with a JSON object in the following format',
		);
	});

	test('falls back to json_object when json_schema is unsupported', async () => {
		const calls: CapturedChatParams[] = [];
		const client = new OpenAIGenericClient({
			client: {
				chat: {
					completions: {
						create: async (params: CapturedChatParams) => {
							calls.push(params);
							if (calls.length === 1) {
								throw new Error('json_schema response_format is unsupported');
							}
							return { choices: [{ message: { content: '{"ok": true}' } }] };
						},
					},
				},
			} as unknown as MockOpenAIClient,
		});

		const result = await client.generateResponse([{ role: 'user', content: 'extract' }], {
			response_model: {
				type: 'object',
				properties: { ok: { type: 'boolean' } },
			},
		});

		expect(result).toEqual({ ok: true });
		const firstCall = calls[0];
		const secondCall = calls[1];
		if (!firstCall || !secondCall) throw new Error('expected fallback OpenAI calls');
		expect(firstCall.response_format.type).toBe('json_schema');
		expect(secondCall.response_format.type).toBe('json_object');
		const secondMessage = secondCall.messages[0];
		if (!secondMessage) throw new Error('expected fallback OpenAI message');
		expect(secondMessage.content).toContain('Respond with a JSON object in the following format');
	});

	test('can be configured to use json_object directly', async () => {
		const calls: CapturedChatParams[] = [];
		const client = new OpenAIGenericClient({
			client: createCapturingOpenAI('{"ok": true}', calls),
			structured_output_mode: 'json_object',
		});

		await client.generateResponse([{ role: 'user', content: 'extract' }], {
			response_model: {
				type: 'object',
				properties: { ok: { type: 'boolean' } },
			},
		});

		expect(calls).toHaveLength(1);
		const firstCall = calls[0];
		if (!firstCall) throw new Error('expected OpenAI call');
		expect(firstCall.response_format.type).toBe('json_object');
	});
});
