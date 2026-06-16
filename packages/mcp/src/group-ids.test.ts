import { describe, expect, test } from 'bun:test';

import { coerceGroupIds } from './group-ids.js';

describe('coerceGroupIds', () => {
	test('uses default for omitted input', () => {
		expect(coerceGroupIds(undefined, 'default')).toEqual(['default']);
		expect(coerceGroupIds(null, 'default')).toEqual(['default']);
	});

	test('wraps a scalar group id', () => {
		expect(coerceGroupIds('team-a', 'default')).toEqual(['team-a']);
	});

	test('passes through normalized arrays', () => {
		expect(coerceGroupIds(['team-a', ' team-b '], 'default')).toEqual(['team-a', 'team-b']);
	});

	test('treats blank input as omitted', () => {
		expect(coerceGroupIds('', 'default')).toEqual(['default']);
		expect(coerceGroupIds(['  '], 'default')).toEqual(['default']);
	});

	test('returns empty array when no input and no default exist', () => {
		expect(coerceGroupIds('', '')).toEqual([]);
		expect(coerceGroupIds(undefined, null)).toEqual([]);
	});
});
