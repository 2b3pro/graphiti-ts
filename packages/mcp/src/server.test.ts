import { describe, expect, test } from 'bun:test';

import { addMemoryToGraphiti } from './server.js';

describe('addMemoryToGraphiti', () => {
	test('routes add_memory through addEpisodeFull', async () => {
		const calls: unknown[] = [];
		const graphiti = {
			addEpisodeFull: async (input: unknown) => {
				calls.push(input);
			},
		};

		const result = await addMemoryToGraphiti(
			graphiti as any,
			{ default_group_id: 'default-group' },
			{
				name: 'episode',
				episode_body: 'Alice knows Bob',
				source: 'message',
				source_description: 'chat',
			},
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			name: 'episode',
			episode_body: 'Alice knows Bob',
			group_id: 'default-group',
			source: 'message',
			source_description: 'chat',
			uuid: null,
		});
		expect(result.isError).toBeUndefined();
	});

	test('returns an MCP error response when addEpisodeFull fails', async () => {
		const graphiti = {
			addEpisodeFull: async () => {
				throw new Error('boom');
			},
		};

		const result = await addMemoryToGraphiti(
			graphiti as any,
			{ default_group_id: 'default-group' },
			{
				name: 'episode',
				episode_body: 'Alice knows Bob',
			},
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain('boom');
	});
});
