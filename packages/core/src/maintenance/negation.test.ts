import { describe, expect, it } from 'bun:test';
import {
  HIGH_CONFIDENCE_NEGATION,
  MEDIUM_CONFIDENCE_NEGATION,
  detectNegation,
} from './negation';

// ─── HIGH_CONFIDENCE_NEGATION patterns ────────────────────────────────────────

describe('HIGH_CONFIDENCE_NEGATION patterns', () => {
  it('matches "no longer"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('PAI no longer uses Redis'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('We use Redis longer than expected'))).toBe(false);
  });

  it('matches "stopped using"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('We stopped using Ollama'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('We stopped, using a new approach'))).toBe(false);
  });

  it('matches "deprecated"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('CascadeShard is deprecated'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('The system needs deprecation strategy'))).toBe(false);
  });

  it('matches "removed"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('We removed the old auth middleware'))).toBe(true);
  });

  it('matches "dropped"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Dropped support for Python 2'))).toBe(true);
  });

  it('matches "decommissioned"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Mysterio was decommissioned'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Decommissioning is a future concern'))).toBe(false);
  });

  it('matches "replaced by" and "replaced with"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Redis replaced by Qdrant'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Replaced Redis with Qdrant'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Redis is a replacement for Memcached'))).toBe(false);
  });

  it('matches "migrated from" and "migrated away"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Migrated from Neo4j to FalkorDB'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('We migrated away from the old stack'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('The migration is complete'))).toBe(false);
  });

  it('matches "switched from" and "switched away"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Switched from Ollama to OpenAI'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('The light switch was flipped'))).toBe(false);
  });

  it('matches "eliminated"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Eliminated the manual review step'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('An elimination round was scheduled'))).toBe(false);
  });

  it('matches "discontinued"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('The service was discontinued'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('Discontinuing is under discussion'))).toBe(false);
  });

  it('matches "no longer uses" and "no longer supports"', () => {
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('PAI no longer uses flat files'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('The API no longer supports v1'))).toBe(true);
    expect(HIGH_CONFIDENCE_NEGATION.some(p => p.test('No longer relevant'))).toBe(true);
  });
});

// ─── MEDIUM_CONFIDENCE_NEGATION patterns ──────────────────────────────────────

describe('MEDIUM_CONFIDENCE_NEGATION patterns', () => {
  it('matches "instead of"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('Use Qdrant instead of Redis'))).toBe(true);
  });

  it('matches "rather than"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('PAI uses Bun rather than Node'))).toBe(true);
  });

  it('matches "used to"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('We used to deploy with Docker'))).toBe(true);
  });

  it('matches "previously"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('Previously we ran on bare metal'))).toBe(true);
  });

  it('matches "formerly"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('Formerly known as CascadeShard'))).toBe(true);
  });

  it('matches "was...now"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('It was Postgres but now it is FalkorDB'))).toBe(true);
  });

  it('matches "changed from" and "changed to"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('Changed from monolith to microservices'))).toBe(true);
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('The policy changed to a new approach'))).toBe(true);
  });

  it('matches "updated from" and "updated to"', () => {
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('Updated from v1 to v2'))).toBe(true);
    expect(MEDIUM_CONFIDENCE_NEGATION.some(p => p.test('Updated to the latest schema'))).toBe(true);
  });
});

// ─── detectNegation() function ────────────────────────────────────────────────

describe('detectNegation()', () => {
  it('returns high confidence when HIGH pattern matches and entity overlap exists', () => {
    const result = detectNegation(
      'PAI no longer uses Redis',
      'PAI uses Redis for caching',
      ['PAI', 'Redis'],
    );
    expect(result.confidence).toBe('high');
    expect(result.pattern).not.toBe('');
  });

  it('downgrades HIGH pattern match to medium when no entity overlap', () => {
    const result = detectNegation(
      'PAI no longer uses Redis',
      'PAI uses Redis for caching',
      [],
    );
    expect(result.confidence).toBe('medium');
    expect(result.pattern).not.toBe('');
  });

  it('returns medium confidence when MEDIUM pattern matches with entity overlap', () => {
    const result = detectNegation(
      'We use Qdrant instead of Redis',
      'We use Redis for vector search',
      ['Redis'],
    );
    expect(result.confidence).toBe('medium');
    expect(result.pattern).not.toBe('');
  });

  it('returns medium confidence when MEDIUM pattern matches without entity overlap', () => {
    const result = detectNegation(
      'We use Qdrant instead of Redis',
      'We use Redis for vector search',
      [],
    );
    expect(result.confidence).toBe('medium');
    expect(result.pattern).not.toBe('');
  });

  it('returns none when no pattern matches', () => {
    const result = detectNegation(
      'PAI uses Redis for caching',
      'PAI uses Redis for session storage',
      ['PAI', 'Redis'],
    );
    expect(result.confidence).toBe('none');
    expect(result.pattern).toBe('');
  });

  it('is case-insensitive', () => {
    const result = detectNegation(
      'PAI NO LONGER USES REDIS',
      'PAI uses Redis for caching',
      ['PAI', 'Redis'],
    );
    expect(result.confidence).toBe('high');
  });

  it('identifies the matched pattern source in the result', () => {
    const result = detectNegation(
      'The service was discontinued in Q4',
      'The service runs in production',
      ['service'],
    );
    expect(result.confidence).toBe('high');
    expect(result.pattern).toContain('discontinued');
  });
});
