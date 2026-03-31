import { expect, test } from 'bun:test';

import { buildDirectedUuidMap } from './union-find';

test('single pair maps source to target', () => {
  const result = buildDirectedUuidMap([['a', 'b']]);
  expect(result.get('a')).toBe('b');
  expect(result.get('b')).toBe('b');
});

test('transitive chain a→b→c compresses to c', () => {
  const result = buildDirectedUuidMap([['a', 'b'], ['b', 'c']]);
  expect(result.get('a')).toBe('c');
  expect(result.get('b')).toBe('c');
  expect(result.get('c')).toBe('c');
});

test('longer chain a→b→c→d', () => {
  const result = buildDirectedUuidMap([['a', 'b'], ['b', 'c'], ['c', 'd']]);
  expect(result.get('a')).toBe('d');
  expect(result.get('b')).toBe('d');
  expect(result.get('c')).toBe('d');
  expect(result.get('d')).toBe('d');
});

test('disconnected sets remain separate', () => {
  const result = buildDirectedUuidMap([['a', 'b'], ['c', 'd']]);
  expect(result.get('a')).toBe('b');
  expect(result.get('b')).toBe('b');
  expect(result.get('c')).toBe('d');
  expect(result.get('d')).toBe('d');
});

test('self-referential pair is identity', () => {
  const result = buildDirectedUuidMap([['a', 'a']]);
  expect(result.get('a')).toBe('a');
});

test('empty pairs returns empty map', () => {
  const result = buildDirectedUuidMap([]);
  expect(result.size).toBe(0);
});

test('convergent chains: a→c, b→c', () => {
  const result = buildDirectedUuidMap([['a', 'c'], ['b', 'c']]);
  expect(result.get('a')).toBe('c');
  expect(result.get('b')).toBe('c');
  expect(result.get('c')).toBe('c');
});

test('reverse order: b→c then a→b still compresses', () => {
  const result = buildDirectedUuidMap([['b', 'c'], ['a', 'b']]);
  expect(result.get('a')).toBe('c');
  expect(result.get('b')).toBe('c');
});
