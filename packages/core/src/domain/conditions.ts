/**
 * Conditional edge awareness — edges that are only valid under certain conditions.
 *
 * Example: "Use Ollama for embeddings" requires Grandier to be online.
 * The edge stores conditions as an array of EdgeCondition objects.
 * At query time, evaluateConditions() checks whether all conditions are met
 * given a map of current entity states.
 */

export type ConditionState = 'active' | 'inactive' | 'any';
export type ConditionRelationship = 'requires' | 'blocked_by';

const VALID_STATES: ReadonlySet<string> = new Set(['active', 'inactive', 'any']);
const VALID_RELATIONSHIPS: ReadonlySet<string> = new Set(['requires', 'blocked_by']);

export interface EdgeCondition {
  entity_uuid: string;
  entity_name: string;
  required_state: ConditionState;
  relationship: ConditionRelationship;
}

/**
 * Validate the structure of an EdgeCondition array.
 * Returns true for null/undefined/empty (unconditional edges).
 * Throws for structurally invalid conditions.
 */
export function validateConditions(
  conditions: EdgeCondition[] | null | undefined
): boolean {
  if (!conditions || conditions.length === 0) return true;

  for (const c of conditions) {
    if (!c.entity_uuid || c.entity_uuid.trim() === '') {
      throw new Error('EdgeCondition: entity_uuid must not be empty');
    }
    if (!VALID_STATES.has(c.required_state)) {
      throw new Error(
        `EdgeCondition: invalid required_state "${c.required_state}" — must be one of: ${[...VALID_STATES].join(', ')}`
      );
    }
    if (!VALID_RELATIONSHIPS.has(c.relationship)) {
      throw new Error(
        `EdgeCondition: invalid relationship "${c.relationship}" — must be one of: ${[...VALID_RELATIONSHIPS].join(', ')}`
      );
    }
  }

  return true;
}

/**
 * Evaluate whether all conditions are met given current entity states.
 *
 * - null/undefined/empty conditions = unconditional, always true.
 * - All conditions must be satisfied (AND semantics).
 * - Unknown entities (not in entityStates) = condition not met.
 * - required_state 'any' = matches any known state (but still requires the entity to be known).
 */
export function evaluateConditions(
  conditions: EdgeCondition[] | null | undefined,
  entityStates: Record<string, ConditionState>
): boolean {
  if (!conditions || conditions.length === 0) return true;

  return conditions.every((c) => {
    const currentState = entityStates[c.entity_uuid];

    // Unknown entity = unresolved = condition not met
    if (currentState === undefined) return false;

    // 'any' matches any known state
    if (c.required_state === 'any') return true;

    // Direct state match
    return currentState === c.required_state;
  });
}
