import { describe, expect, test } from 'bun:test';
import { EntityTypeValidationError } from '@graphiti/shared';

import { validateEntityTypes, validateExcludedEntityTypes } from './entity-types';

// ---------------------------------------------------------------------------
// validateEntityTypes
// ---------------------------------------------------------------------------

describe('validateEntityTypes', () => {
  test('returns true for valid non-reserved field names', () => {
    expect(validateEntityTypes(['age', 'email', 'phone'])).toBe(true);
  });

  test('throws EntityTypeValidationError for reserved field "uuid"', () => {
    expect(() => validateEntityTypes(['uuid'])).toThrow(EntityTypeValidationError);
  });

  test('throws for reserved field "name"', () => {
    expect(() => validateEntityTypes(['name'])).toThrow(EntityTypeValidationError);
  });

  test('throws for reserved field "group_id"', () => {
    expect(() => validateEntityTypes(['group_id'])).toThrow(EntityTypeValidationError);
  });

  test('throws for reserved field "labels"', () => {
    expect(() => validateEntityTypes(['labels'])).toThrow(EntityTypeValidationError);
  });

  test('throws for reserved field "created_at"', () => {
    expect(() => validateEntityTypes(['created_at'])).toThrow(EntityTypeValidationError);
  });

  test('throws for reserved field "summary"', () => {
    expect(() => validateEntityTypes(['summary'])).toThrow(EntityTypeValidationError);
  });

  test('throws for reserved field "name_embedding"', () => {
    expect(() => validateEntityTypes(['name_embedding'])).toThrow(EntityTypeValidationError);
  });

  test('throws for reserved field "attributes"', () => {
    expect(() => validateEntityTypes(['attributes'])).toThrow(EntityTypeValidationError);
  });

  test('returns true for empty field list', () => {
    expect(validateEntityTypes([])).toBe(true);
  });

  test('throws if any field is reserved even among valid ones', () => {
    expect(() => validateEntityTypes(['age', 'uuid', 'email'])).toThrow(
      EntityTypeValidationError
    );
  });
});

// ---------------------------------------------------------------------------
// validateExcludedEntityTypes
// ---------------------------------------------------------------------------

describe('validateExcludedEntityTypes', () => {
  test('returns true for valid non-empty type names', () => {
    expect(validateExcludedEntityTypes(['Person', 'Organization'])).toBe(true);
  });

  test('throws for empty string type name', () => {
    expect(() => validateExcludedEntityTypes([''])).toThrow(EntityTypeValidationError);
  });

  test('throws for whitespace-only type name', () => {
    expect(() => validateExcludedEntityTypes(['  '])).toThrow(EntityTypeValidationError);
  });

  test('returns true for empty type name list', () => {
    expect(validateExcludedEntityTypes([])).toBe(true);
  });
});
