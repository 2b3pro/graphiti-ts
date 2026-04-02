import { describe, expect, it } from 'bun:test';
import {
  computeStaleness,
  DOMAIN_VELOCITY,
  STALENESS_SLOPE,
  STALENESS_MIDPOINT_DAYS,
  REINFORCEMENT_DECAY,
  RECENCY_WINDOW_DAYS,
  type StalenessFactors,
} from './staleness';

// ---------------------------------------------------------------------------
// computeStaleness
// ---------------------------------------------------------------------------

describe('computeStaleness', () => {
  it('returns near zero for a fresh edge (recently reinforced)', () => {
    const factors: StalenessFactors = {
      age_days: 5,
      last_reinforced_days: 2,
      domain_velocity: 0.5,
      reinforcement_count: 3,
    };
    const score = computeStaleness(factors);
    expect(score).toBeLessThan(0.1);
  });

  it('returns ~0.5 at sigmoid midpoint with no reinforcement and average velocity', () => {
    const factors: StalenessFactors = {
      age_days: 90,
      last_reinforced_days: null,
      domain_velocity: 0.5,
      reinforcement_count: 0,
    };
    const score = computeStaleness(factors);
    // velocityMultiplier = 0.5 + 0.5 = 1.0, reinforcementFactor = 1.0, recencyFactor = 1.0
    // result should be ~0.5
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('returns near 1.0 for a very old edge with no reinforcement and high velocity', () => {
    const factors: StalenessFactors = {
      age_days: 365,
      last_reinforced_days: null,
      domain_velocity: 0.7,
      reinforcement_count: 0,
    };
    const score = computeStaleness(factors);
    expect(score).toBeGreaterThan(0.9);
  });

  it('reinforcements reduce staleness', () => {
    const base: StalenessFactors = {
      age_days: 90,
      last_reinforced_days: null,
      domain_velocity: 0.5,
      reinforcement_count: 0,
    };
    const reinforced: StalenessFactors = {
      ...base,
      reinforcement_count: 5,
    };
    expect(computeStaleness(reinforced)).toBeLessThan(computeStaleness(base));
  });

  it('higher domain velocity increases staleness', () => {
    const lowVelocity: StalenessFactors = {
      age_days: 60,
      last_reinforced_days: null,
      domain_velocity: 0.2,
      reinforcement_count: 0,
    };
    const highVelocity: StalenessFactors = {
      ...lowVelocity,
      domain_velocity: 0.8,
    };
    expect(computeStaleness(highVelocity)).toBeGreaterThan(computeStaleness(lowVelocity));
  });

  it('never returns below 0 (extreme fresh case)', () => {
    const factors: StalenessFactors = {
      age_days: 0,
      last_reinforced_days: 0,
      domain_velocity: 0.0,
      reinforcement_count: 100,
    };
    const score = computeStaleness(factors);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('never returns above 1 (extreme stale case)', () => {
    const factors: StalenessFactors = {
      age_days: 10000,
      last_reinforced_days: null,
      domain_velocity: 1.0,
      reinforcement_count: 0,
    };
    const score = computeStaleness(factors);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('recent reinforcement reduces staleness more than old reinforcement', () => {
    const recentReinforced: StalenessFactors = {
      age_days: 120,
      last_reinforced_days: 10,
      domain_velocity: 0.5,
      reinforcement_count: 2,
    };
    const oldReinforced: StalenessFactors = {
      ...recentReinforced,
      last_reinforced_days: 90,
    };
    expect(computeStaleness(recentReinforced)).toBeLessThan(computeStaleness(oldReinforced));
  });
});

// ---------------------------------------------------------------------------
// DOMAIN_VELOCITY constant
// ---------------------------------------------------------------------------

describe('DOMAIN_VELOCITY', () => {
  it('has entries for all expected entity types', () => {
    const expected = [
      'Tool', 'Server', 'Project', 'Decision',
      'Feedback', 'Concept', 'Person', 'Reference',
    ];
    for (const type of expected) {
      expect(DOMAIN_VELOCITY[type]).toBeDefined();
    }
  });

  it('all values are between 0 and 1 (inclusive)', () => {
    for (const [key, value] of Object.entries(DOMAIN_VELOCITY)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      void key; // suppress unused variable warning
    }
  });
});

// ---------------------------------------------------------------------------
// Tuning constants sanity checks
// ---------------------------------------------------------------------------

describe('staleness tuning constants', () => {
  it('STALENESS_SLOPE is 0.05', () => {
    expect(STALENESS_SLOPE).toBe(0.05);
  });

  it('STALENESS_MIDPOINT_DAYS is 90', () => {
    expect(STALENESS_MIDPOINT_DAYS).toBe(90);
  });

  it('REINFORCEMENT_DECAY is 0.1', () => {
    expect(REINFORCEMENT_DECAY).toBe(0.1);
  });

  it('RECENCY_WINDOW_DAYS is 60', () => {
    expect(RECENCY_WINDOW_DAYS).toBe(60);
  });
});
