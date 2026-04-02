import { describe, expect, it } from 'bun:test';
import {
  validateConditions,
  evaluateConditions,
  type EdgeCondition,
  type ConditionState,
} from './conditions';

describe('validateConditions', () => {
  it('returns true for null', () => {
    expect(validateConditions(null)).toBe(true);
  });

  it('returns true for undefined', () => {
    expect(validateConditions(undefined)).toBe(true);
  });

  it('returns true for empty array', () => {
    expect(validateConditions([])).toBe(true);
  });

  it('returns true for valid conditions', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'active',
        relationship: 'requires',
      },
    ];
    expect(validateConditions(conditions)).toBe(true);
  });

  it('rejects invalid required_state', () => {
    const conditions = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'maybe' as ConditionState,
        relationship: 'requires' as const,
      },
    ];
    expect(() => validateConditions(conditions)).toThrow('required_state');
  });

  it('rejects empty entity_uuid', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: '',
        entity_name: 'Grandier',
        required_state: 'active',
        relationship: 'requires',
      },
    ];
    expect(() => validateConditions(conditions)).toThrow('entity_uuid');
  });
});

describe('evaluateConditions', () => {
  it('unconditional (null) always passes', () => {
    expect(evaluateConditions(null, {})).toBe(true);
  });

  it('unconditional (undefined) always passes', () => {
    expect(evaluateConditions(undefined, {})).toBe(true);
  });

  it('unconditional (empty) always passes', () => {
    expect(evaluateConditions([], {})).toBe(true);
  });

  it('single condition met returns true', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'active',
        relationship: 'requires',
      },
    ];
    expect(evaluateConditions(conditions, { 'uuid-1': 'active' })).toBe(true);
  });

  it('single condition not met returns false', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'active',
        relationship: 'requires',
      },
    ];
    expect(evaluateConditions(conditions, { 'uuid-1': 'inactive' })).toBe(false);
  });

  it('unknown entity defaults to unresolved (false)', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-unknown',
        entity_name: 'Mystery',
        required_state: 'active',
        relationship: 'requires',
      },
    ];
    expect(evaluateConditions(conditions, {})).toBe(false);
  });

  it("'any' state passes when entity is known", () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'any',
        relationship: 'requires',
      },
    ];
    expect(evaluateConditions(conditions, { 'uuid-1': 'inactive' })).toBe(true);
    expect(evaluateConditions(conditions, { 'uuid-1': 'active' })).toBe(true);
  });

  it("'any' state fails when entity is unknown", () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'any',
        relationship: 'requires',
      },
    ];
    expect(evaluateConditions(conditions, {})).toBe(false);
  });

  it('multiple conditions use AND semantics', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'active',
        relationship: 'requires',
      },
      {
        entity_uuid: 'uuid-2',
        entity_name: 'Ollama',
        required_state: 'active',
        relationship: 'requires',
      },
    ];
    expect(
      evaluateConditions(conditions, { 'uuid-1': 'active', 'uuid-2': 'active' })
    ).toBe(true);
  });

  it('partial match fails (AND semantics)', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Grandier',
        required_state: 'active',
        relationship: 'requires',
      },
      {
        entity_uuid: 'uuid-2',
        entity_name: 'Ollama',
        required_state: 'active',
        relationship: 'requires',
      },
    ];
    expect(
      evaluateConditions(conditions, { 'uuid-1': 'active', 'uuid-2': 'inactive' })
    ).toBe(false);
  });

  it('blocked_by with inactive state passes', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Firewall',
        required_state: 'inactive',
        relationship: 'blocked_by',
      },
    ];
    expect(evaluateConditions(conditions, { 'uuid-1': 'inactive' })).toBe(true);
  });

  it('blocked_by with active state fails', () => {
    const conditions: EdgeCondition[] = [
      {
        entity_uuid: 'uuid-1',
        entity_name: 'Firewall',
        required_state: 'inactive',
        relationship: 'blocked_by',
      },
    ];
    expect(evaluateConditions(conditions, { 'uuid-1': 'active' })).toBe(false);
  });
});
