import { describe, test, expect } from 'bun:test';
import { createSearchFilters, edgeSearchFilterQueryConstructor } from './filters';

/**
 * Regression tests for the two bugs that made `Graphiti.searchAsOf()` return
 * zero edges for every date (PAI INC: `gmem asof` always empty).
 *
 * These assert on the *generated Cypher*, not on a faked driver — the prior
 * searchAsOf test used a fake Neo4j client that ignored the WHERE clause, so it
 * passed while the real filter matched nothing.
 */
describe('searchAsOf temporal filter construction', () => {
  // The exact filter shape searchAsOf builds.
  const asOf = new Date('2026-04-15T23:59:59.000Z');
  const filters = createSearchFilters({
    valid_at: [[{ date: asOf, comparison_operator: '<=' }]],
    invalid_at: [
      [{ date: asOf, comparison_operator: '>' }],
      [{ comparison_operator: 'IS NULL' }],
    ],
  });
  const [clauses, params] = edgeSearchFilterQueryConstructor(filters, 'neo4j' as never);
  const where = clauses.join(' && ');

  test('invalid_at clause is OR-joined, not a contradictory AND', () => {
    // Bug 1: `(invalid_at > d AND invalid_at IS NULL)` can never be true.
    expect(where).toContain('(e.invalid_at > $invalid_at_0) OR (e.invalid_at IS NULL)');
    expect(where).not.toContain('e.invalid_at > $invalid_at_0) AND (e.invalid_at IS NULL');
  });

  test('valid_at bound is present', () => {
    expect(where).toContain('e.valid_at <= $valid_at_0');
  });

  test('date params are ISO strings, not Date objects', () => {
    // Bug 2: date properties are stored as ISO strings (serializeForCypher);
    // a Date param serializes to a Neo4j DateTime and `string <op> datetime`
    // silently matches nothing.
    expect(typeof params.valid_at_0).toBe('string');
    expect(params.valid_at_0).toBe('2026-04-15T23:59:59.000Z');
    expect(typeof params.invalid_at_0).toBe('string');
    expect(params.invalid_at_0).toBe('2026-04-15T23:59:59.000Z');
    expect(params.valid_at_0 instanceof Date).toBe(false);
  });

  test('created_at and expired_at date params are stringified too', () => {
    // The fix lives in the shared appendDateFilters, so it covers every
    // DateFilter field, not just the two searchAsOf happens to use.
    const d = new Date('2026-05-01T00:00:00.000Z');
    const f = createSearchFilters({
      created_at: [[{ date: d, comparison_operator: '>=' }]],
      expired_at: [[{ date: d, comparison_operator: '<' }]],
    });
    const [, p] = edgeSearchFilterQueryConstructor(f, 'neo4j' as never);
    expect(p.created_at_0).toBe('2026-05-01T00:00:00.000Z');
    expect(p.expired_at_0).toBe('2026-05-01T00:00:00.000Z');
  });

  test('a pre-formatted ISO string passes through unchanged', () => {
    // DateFilter.date accepts `Date | string`; an ISO string must not be
    // double-processed or rejected.
    const f = createSearchFilters({
      valid_at: [[{ date: '2026-06-15T12:00:00.000Z', comparison_operator: '<=' }]],
    });
    const [, p] = edgeSearchFilterQueryConstructor(f, 'neo4j' as never);
    expect(p.valid_at_0).toBe('2026-06-15T12:00:00.000Z');
  });
});
