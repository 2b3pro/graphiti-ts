import { describe, expect, test } from 'bun:test';

import { formatEdgeDateRange, searchResultsToContextString } from './helpers';
import type { EntityEdge } from '../domain/edges';
import { createSearchResults } from './config';

// ---------------------------------------------------------------------------
// formatEdgeDateRange
// ---------------------------------------------------------------------------

describe('formatEdgeDateRange', () => {
  test('formats both valid_at and invalid_at dates', () => {
    const edge = {
      uuid: 'e1',
      group_id: 'g1',
      source_node_uuid: 'n1',
      target_node_uuid: 'n2',
      created_at: new Date('2024-01-01'),
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
      valid_at: new Date('2024-01-15T10:00:00Z'),
      invalid_at: new Date('2024-06-30T18:00:00Z')
    } satisfies EntityEdge;

    const result = formatEdgeDateRange(edge);
    expect(result).toContain('2024-01-15');
    expect(result).toContain('2024-06-30');
    expect(result).toContain(' - ');
  });

  test('shows "unknown" for missing valid_at', () => {
    const edge = {
      uuid: 'e1',
      group_id: 'g1',
      source_node_uuid: 'n1',
      target_node_uuid: 'n2',
      created_at: new Date('2024-01-01'),
      name: 'REL',
      fact: 'fact',
      valid_at: null,
      invalid_at: new Date('2024-06-30T00:00:00Z')
    } satisfies EntityEdge;

    expect(formatEdgeDateRange(edge)).toMatch(/^unknown - /);
  });

  test('shows "present" for missing invalid_at', () => {
    const edge = {
      uuid: 'e1',
      group_id: 'g1',
      source_node_uuid: 'n1',
      target_node_uuid: 'n2',
      created_at: new Date('2024-01-01'),
      name: 'REL',
      fact: 'fact',
      valid_at: new Date('2024-01-01'),
      invalid_at: null
    } satisfies EntityEdge;

    expect(formatEdgeDateRange(edge)).toMatch(/ - present$/);
  });

  test('shows "unknown - present" when both dates null', () => {
    const edge = {
      uuid: 'e1',
      group_id: 'g1',
      source_node_uuid: 'n1',
      target_node_uuid: 'n2',
      created_at: new Date(),
      name: 'REL',
      fact: 'fact'
    } satisfies EntityEdge;

    expect(formatEdgeDateRange(edge)).toBe('unknown - present');
  });
});

// ---------------------------------------------------------------------------
// searchResultsToContextString
// ---------------------------------------------------------------------------

describe('searchResultsToContextString', () => {
  const emptyResults = createSearchResults();

  test('returns empty string for empty results', () => {
    expect(searchResultsToContextString(emptyResults)).toBe('');
  });

  test('includes facts section when edges present', () => {
    const results = {
      ...createSearchResults(),
      edges: [
        {
          uuid: 'e1',
          group_id: 'g1',
          source_node_uuid: 'n1',
          target_node_uuid: 'n2',
          created_at: new Date(),
          name: 'WORKS_AT',
          fact: 'Alice works at Acme',
          valid_at: new Date('2024-01-01'),
          invalid_at: null
        }
      ]
    };

    const ctx = searchResultsToContextString(results);
    expect(ctx).toContain('<facts>');
    expect(ctx).toContain('Alice works at Acme');
    expect(ctx).toContain('</facts>');
  });

  test('includes entities section when nodes present', () => {
    const results = {
      ...createSearchResults(),
      nodes: [
        {
          uuid: 'n1',
          name: 'Alice',
          group_id: 'g1',
          labels: ['Entity', 'Person'],
          created_at: new Date(),
          summary: 'Software engineer'
        }
      ]
    };

    const ctx = searchResultsToContextString(results);
    expect(ctx).toContain('<entities>');
    expect(ctx).toContain('Alice');
    expect(ctx).toContain('Software engineer');
    expect(ctx).toContain('</entities>');
  });

  test('includes episodes section when episodes present', () => {
    const results = {
      ...createSearchResults(),
      episodes: [
        {
          uuid: 'ep1',
          name: 'ep1',
          group_id: 'g1',
          labels: ['Episode'],
          created_at: new Date(),
          source: 'message' as const,
          source_description: 'test',
          content: 'Hello world',
          valid_at: new Date('2024-03-01')
        }
      ]
    };

    const ctx = searchResultsToContextString(results);
    expect(ctx).toContain('<episodes>');
    expect(ctx).toContain('Hello world');
    expect(ctx).toContain('</episodes>');
  });

  test('includes communities section when communities present', () => {
    const results = {
      ...createSearchResults(),
      communities: [
        {
          uuid: 'c1',
          name: 'Tech Community',
          group_id: 'g1',
          labels: ['Community'],
          created_at: new Date(),
          summary: 'Technology focused group'
        }
      ]
    };

    const ctx = searchResultsToContextString(results);
    expect(ctx).toContain('<communities>');
    expect(ctx).toContain('Tech Community');
    expect(ctx).toContain('</communities>');
  });

  test('includes all sections when all result types present', () => {
    const results = createSearchResults({
      edges: [
        {
          uuid: 'e1',
          group_id: 'g1',
          source_node_uuid: 'n1',
          target_node_uuid: 'n2',
          created_at: new Date(),
          name: 'REL',
          fact: 'edge fact'
        }
      ],
      nodes: [
        {
          uuid: 'n1',
          name: 'Node1',
          group_id: 'g1',
          labels: ['Entity'],
          created_at: new Date(),
          summary: 'summary'
        }
      ],
      episodes: [
        {
          uuid: 'ep1',
          name: 'ep1',
          group_id: 'g1',
          labels: ['Episode'],
          created_at: new Date(),
          source: 'text' as const,
          source_description: 'test',
          content: 'episode content'
        }
      ],
      communities: [
        {
          uuid: 'c1',
          name: 'Comm1',
          group_id: 'g1',
          labels: ['Community'],
          created_at: new Date(),
          summary: 'comm summary'
        }
      ]
    });

    const ctx = searchResultsToContextString(results);
    expect(ctx).toContain('<facts>');
    expect(ctx).toContain('<entities>');
    expect(ctx).toContain('<episodes>');
    expect(ctx).toContain('<communities>');
  });
});
