/**
 * Entity type validation — port of Python's graphiti_core/utils/ontology_utils/entity_types_utils.py.
 */

import { EntityTypeValidationError } from '@graphiti/shared';

/**
 * Reserved field names from the base EntityNode interface.
 * Custom entity types must not collide with these.
 */
const RESERVED_ENTITY_FIELDS = new Set([
  'uuid',
  'name',
  'group_id',
  'labels',
  'created_at',
  'summary',
  'name_embedding',
  'summary_embedding',
  'attributes'
]);

/**
 * Validate that custom entity type field names don't conflict with
 * reserved EntityNode field names.
 *
 * @param fieldNames - Array of field names from the custom entity type
 * @returns true if valid
 * @throws EntityTypeValidationError if a field name conflicts
 */
export function validateEntityTypes(fieldNames: string[]): boolean {
  for (const field of fieldNames) {
    if (RESERVED_ENTITY_FIELDS.has(field)) {
      throw new EntityTypeValidationError('custom', field);
    }
  }
  return true;
}

/**
 * Validate that excluded entity type names are valid identifiers.
 */
export function validateExcludedEntityTypes(typeNames: string[]): boolean {
  for (const name of typeNames) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new EntityTypeValidationError(name ?? 'undefined', 'name');
    }
  }
  return true;
}
