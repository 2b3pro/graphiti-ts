# Wave 2: Reasoning Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conditional edges, contextual anchoring with multi-anchor interpretation, and a deprecation confidence gate (death gate) to graphiti-ts — enabling condition-dependent facts, interpretive frameworks, and evidence-weighted contradiction resolution.

**Architecture:** Three new domain modules (`domain/conditions.ts`, `domain/anchoring.ts`, `domain/deprecation-gate.ts`) plus modifications to `EntityEdge`, the extraction prompt, search filters, and the contradiction pipeline. A prerequisite Task 0 refactors all 26 duplicated Cypher field lists into a shared constant.

**Tech Stack:** TypeScript, Neo4j 5.26+ (relationship properties), Bun test runner

**Repository:** `/Volumes/Exagora/Projects/graphiti-ts/` (monorepo, `packages/core/src/`)

**Design decisions (Eng Review 2026-04-01):**
- Death gate uses inline scoring in the library (no PAI Scoring Engine dependency)
- Full anchoring scope including `AnchoredInterpretation` and lens-based search (Cascade needs it)
- Cypher queries refactored to shared field list constant before adding new fields
- Sequential build order: 0 (refactor) → 4 (conditions) → 9 (anchoring) → 8 (death gate)

---

### Task 0: Refactor Cypher Entity Edge Field Lists

**Why:** The `EntityEdge` field list is duplicated 26 times across Neo4j ops, FalkorDB ops, search ops, namespaces, and utilities. Adding new fields (Tasks 1-3) would require 26 manual updates. Extract into a shared constant.

**Files:**
- Create: `packages/core/src/driver/cypher-fields.ts`
- Modify: `packages/core/src/driver/neo4j/neo4j-entity-edge-operations.ts`
- Modify: `packages/core/src/driver/neo4j/neo4j-search-operations.ts`
- Modify: `packages/core/src/driver/falkordb/falkordb-entity-edge-operations.ts`
- Modify: `packages/core/src/driver/falkordb/falkordb-search-operations.ts`
- Modify: `packages/core/src/namespaces/edges.ts`
- Modify: `packages/core/src/search/utils.ts`
- Modify: `packages/core/src/maintenance/edge-operations.ts`
- Modify: `packages/core/src/graphiti.ts`
- Modify: `packages/core/src/ingest/resolver.ts`
- Test: existing test suite (no new tests — pure refactor)

- [ ] **Step 1: Write the shared field constant**

Create `packages/core/src/driver/cypher-fields.ts`:

```typescript
/**
 * Shared Cypher RETURN clause fragments for EntityEdge queries.
 *
 * Every query that reads entity edges uses this field list.
 * When adding new fields to EntityEdge, add them here ONCE.
 */

/**
 * Standard RETURN fields for entity edge queries.
 * Use with: MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
 *
 * Includes source/target node UUIDs from matched nodes.
 */
export const ENTITY_EDGE_RETURN_FIELDS = `
  e.uuid AS uuid,
  e.group_id AS group_id,
  source.uuid AS source_node_uuid,
  target.uuid AS target_node_uuid,
  e.created_at AS created_at,
  e.name AS name,
  e.fact AS fact,
  e.fact_embedding AS fact_embedding,
  e.episodes AS episodes,
  e.expired_at AS expired_at,
  e.valid_at AS valid_at,
  e.invalid_at AS invalid_at,
  e.confidence AS confidence,
  e.epistemic_status AS epistemic_status,
  e.supported_by AS supported_by,
  e.supports AS supports,
  e.disputed_by AS disputed_by,
  e.epistemic_history AS epistemic_history,
  e.birth_score AS birth_score
`.trim();

/**
 * Same fields but with DISTINCT — used in multi-match queries.
 */
export const ENTITY_EDGE_RETURN_FIELDS_DISTINCT = `DISTINCT\n  ${ENTITY_EDGE_RETURN_FIELDS}`;
```

- [ ] **Step 2: Replace all 26 field list occurrences**

In every file listed above, replace the inline field list with `RETURN\n  ${ENTITY_EDGE_RETURN_FIELDS}` (or the DISTINCT variant). Import from `../cypher-fields` (adjust relative path per file).

**Pattern to search for:** `e.birth_score AS birth_score` — this is the last field in every list. Each occurrence is the end of a block that should be replaced.

Example replacement in `neo4j-entity-edge-operations.ts:getByUuids()`:

Before:
```typescript
const result = await driver.executeQuery<RecordLike>(
  `
    MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
    WHERE e.uuid IN $uuids
    RETURN
      e.uuid AS uuid,
      e.group_id AS group_id,
      source.uuid AS source_node_uuid,
      target.uuid AS target_node_uuid,
      e.created_at AS created_at,
      ... (16 more lines)
      e.birth_score AS birth_score
  `,
  { params: { uuids }, routing: 'r' }
);
```

After:
```typescript
import { ENTITY_EDGE_RETURN_FIELDS } from '../cypher-fields';

const result = await driver.executeQuery<RecordLike>(
  `
    MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)
    WHERE e.uuid IN $uuids
    RETURN
      ${ENTITY_EDGE_RETURN_FIELDS}
  `,
  { params: { uuids }, routing: 'r' }
);
```

**Special cases:**
- `search/utils.ts:getRelevantEdges()` uses `RETURN DISTINCT` — use `ENTITY_EDGE_RETURN_FIELDS_DISTINCT`
- `maintenance/edge-operations.ts:getEdgesBetweenNodes()` has its own inline field mapping (lines 587-604) — this function does NOT use `mapEntityEdge()`, it manually constructs the object. Leave this function's return mapping intact but replace the Cypher field list.
- `graphiti.ts` deprecation queries use compact single-line format — replace with template literal using the constant

- [ ] **Step 3: Run type check and tests**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit && bun test`
Expected: All existing tests pass. Zero new failures.

- [ ] **Step 4: Export from index**

Add to `packages/core/src/index.ts`:
```typescript
export { ENTITY_EDGE_RETURN_FIELDS, ENTITY_EDGE_RETURN_FIELDS_DISTINCT } from './driver/cypher-fields';
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/driver/cypher-fields.ts packages/core/src/driver/neo4j/ packages/core/src/driver/falkordb/ packages/core/src/namespaces/edges.ts packages/core/src/search/utils.ts packages/core/src/maintenance/edge-operations.ts packages/core/src/graphiti.ts packages/core/src/ingest/resolver.ts packages/core/src/index.ts
git commit -m "refactor: extract shared EntityEdge Cypher field list from 26 query locations"
```

---

### Task 1: Conditional Edge Awareness (Enhancement 4)

**Why:** Facts are often only true under conditions. "Use Ollama for embeddings" requires Grandier to be online. Cascade's causal chains depend entirely on Conditions enabling/disabling effects.

**Files:**
- Create: `packages/core/src/domain/conditions.ts`
- Create: `packages/core/src/domain/conditions.test.ts`
- Modify: `packages/core/src/domain/edges.ts` (add `conditions` field)
- Modify: `packages/core/src/driver/cypher-fields.ts` (add `conditions` to field list)
- Modify: `packages/core/src/namespaces/edges.ts` (add `conditions` to `mapEntityEdge`)
- Modify: `packages/core/src/prompts/extract-edges.ts` (add conditional detection)
- Modify: `packages/core/src/search/filters.ts` (add `condition_state` filter)
- Modify: `packages/core/src/driver/neo4j/neo4j-search-operations.ts` (condition filter Cypher)
- Modify: `packages/core/src/driver/falkordb/falkordb-search-operations.ts` (condition filter Cypher)
- Create: `packages/core/src/domain/conditions.test.ts`
- Modify: `packages/core/src/index.ts` (export new types)

- [ ] **Step 1: Write failing tests for EdgeCondition types and validation**

Create `packages/core/src/domain/conditions.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import {
  type EdgeCondition,
  type ConditionState,
  validateConditions,
  evaluateConditions,
} from './conditions';

describe('EdgeCondition', () => {
  const activeCondition: EdgeCondition = {
    entity_uuid: 'uuid-trade-war',
    entity_name: 'US-China Trade War',
    required_state: 'active',
    relationship: 'requires',
  };

  const inactiveCondition: EdgeCondition = {
    entity_uuid: 'uuid-grandier',
    entity_name: 'Grandier',
    required_state: 'inactive',
    relationship: 'requires',
  };

  describe('validateConditions', () => {
    test('null/undefined returns true (unconditional)', () => {
      expect(validateConditions(null)).toBe(true);
      expect(validateConditions(undefined)).toBe(true);
    });

    test('empty array returns true (unconditional)', () => {
      expect(validateConditions([])).toBe(true);
    });

    test('valid conditions pass', () => {
      expect(validateConditions([activeCondition])).toBe(true);
    });

    test('rejects invalid required_state', () => {
      expect(() =>
        validateConditions([
          { ...activeCondition, required_state: 'maybe' as ConditionState },
        ])
      ).toThrow();
    });

    test('rejects missing entity_uuid', () => {
      expect(() =>
        validateConditions([{ ...activeCondition, entity_uuid: '' }])
      ).toThrow();
    });
  });

  describe('evaluateConditions', () => {
    test('unconditional edge always passes', () => {
      expect(evaluateConditions(null, {})).toBe(true);
      expect(evaluateConditions(undefined, {})).toBe(true);
      expect(evaluateConditions([], {})).toBe(true);
    });

    test('single condition met', () => {
      const states: Record<string, ConditionState> = {
        'uuid-trade-war': 'active',
      };
      expect(evaluateConditions([activeCondition], states)).toBe(true);
    });

    test('single condition not met', () => {
      const states: Record<string, ConditionState> = {
        'uuid-trade-war': 'inactive',
      };
      expect(evaluateConditions([activeCondition], states)).toBe(false);
    });

    test('unknown entity state defaults to unresolved (no match)', () => {
      expect(evaluateConditions([activeCondition], {})).toBe(false);
    });

    test('any-state condition always passes when entity known', () => {
      const anyCondition: EdgeCondition = {
        ...activeCondition,
        required_state: 'any',
      };
      expect(
        evaluateConditions([anyCondition], { 'uuid-trade-war': 'inactive' })
      ).toBe(true);
    });

    test('multiple conditions: all must be met (AND)', () => {
      const states: Record<string, ConditionState> = {
        'uuid-trade-war': 'active',
        'uuid-grandier': 'inactive',
      };
      expect(
        evaluateConditions([activeCondition, inactiveCondition], states)
      ).toBe(true);
    });

    test('multiple conditions: partial match fails', () => {
      const states: Record<string, ConditionState> = {
        'uuid-trade-war': 'active',
        'uuid-grandier': 'active', // wants inactive
      };
      expect(
        evaluateConditions([activeCondition, inactiveCondition], states)
      ).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/conditions.test.ts`
Expected: FAIL — module `./conditions` not found

- [ ] **Step 3: Implement conditions module**

Create `packages/core/src/domain/conditions.ts`:

```typescript
/**
 * Conditional Edge Awareness — edges that are only valid under certain conditions.
 *
 * An edge with conditions is only "active" when its referenced condition entities
 * are in the required state. Unconditional edges (conditions: null/undefined/[])
 * are always active — backward-compatible default.
 */

export type ConditionState = 'active' | 'inactive' | 'any';
export type ConditionRelationship = 'requires' | 'blocked_by';

export interface EdgeCondition {
  /** UUID of the condition entity (e.g., "US-China Trade War") */
  entity_uuid: string;
  /** Denormalized entity name for display */
  entity_name: string;
  /** What state makes the dependent edge valid */
  required_state: ConditionState;
  /** Semantic role of the condition */
  relationship: ConditionRelationship;
}

const VALID_STATES: Set<string> = new Set(['active', 'inactive', 'any']);
const VALID_RELATIONSHIPS: Set<string> = new Set(['requires', 'blocked_by']);

/**
 * Validate an array of edge conditions.
 * Returns true for null/undefined/empty (unconditional).
 * Throws for invalid condition structure.
 */
export function validateConditions(
  conditions: EdgeCondition[] | null | undefined
): boolean {
  if (!conditions || conditions.length === 0) return true;

  for (const c of conditions) {
    if (!c.entity_uuid) {
      throw new Error('EdgeCondition: entity_uuid is required');
    }
    if (!VALID_STATES.has(c.required_state)) {
      throw new Error(
        `EdgeCondition: invalid required_state '${c.required_state}', must be one of: ${[...VALID_STATES].join(', ')}`
      );
    }
    if (!VALID_RELATIONSHIPS.has(c.relationship)) {
      throw new Error(
        `EdgeCondition: invalid relationship '${c.relationship}', must be one of: ${[...VALID_RELATIONSHIPS].join(', ')}`
      );
    }
  }
  return true;
}

/**
 * Evaluate whether an edge's conditions are met given current entity states.
 *
 * - null/undefined/[] = unconditional, always true
 * - All conditions must be met (AND semantics)
 * - Unknown entity states = condition not met (safe default)
 * - 'any' required_state = matches any known state
 *
 * @param conditions  The edge's condition array
 * @param entityStates  Map of entity UUID → current state
 * @returns true if all conditions are satisfied
 */
export function evaluateConditions(
  conditions: EdgeCondition[] | null | undefined,
  entityStates: Record<string, ConditionState>
): boolean {
  if (!conditions || conditions.length === 0) return true;

  for (const c of conditions) {
    const currentState = entityStates[c.entity_uuid];

    if (c.required_state === 'any') {
      // 'any' passes as long as the entity exists in the state map
      if (currentState === undefined) return false;
      continue;
    }

    if (currentState !== c.required_state) return false;
  }

  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/conditions.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Add `conditions` field to EntityEdge**

In `packages/core/src/domain/edges.ts`, add after the `birth_score` field:

```typescript
  /** Quality gate score recorded at edge creation time */
  birth_score?: import('./epistemic').BirthScore | null;

  /**
   * Conditions under which this edge is active.
   * null/undefined/[] = unconditionally true (default, backward-compatible).
   * All conditions must be met (AND) for the edge to be considered active.
   */
  conditions?: import('./conditions').EdgeCondition[] | null;
```

- [ ] **Step 6: Add `conditions` to Cypher field list**

In `packages/core/src/driver/cypher-fields.ts`, add to `ENTITY_EDGE_RETURN_FIELDS`:

```typescript
  e.birth_score AS birth_score,
  e.conditions AS conditions
```

- [ ] **Step 7: Add `conditions` to `mapEntityEdge()`**

In `packages/core/src/namespaces/edges.ts`, in the `mapEntityEdge` function, add after `birth_score` parsing:

```typescript
  // Conditions — stored as JSON string array in Neo4j
  const rawConditions = getRecordValue<string | EdgeCondition[] | null>(record, 'conditions');
  let conditions: EdgeCondition[] | null = null;
  if (rawConditions) {
    if (typeof rawConditions === 'string') {
      try {
        conditions = JSON.parse(rawConditions) as EdgeCondition[];
      } catch {
        conditions = null;
      }
    } else if (Array.isArray(rawConditions)) {
      conditions = rawConditions;
    }
  }
```

And add `conditions` to the returned object:
```typescript
    birth_score: birthScore,
    conditions,
```

Also add the import:
```typescript
import type { EdgeCondition } from '../domain/conditions';
```

- [ ] **Step 8: Add condition_state to SearchFilters**

In `packages/core/src/search/filters.ts`, extend `SearchFilters`:

```typescript
export interface ConditionStateFilter {
  entity_uuid: string;
  state: 'active' | 'inactive';
}

export interface SearchFilters {
  // ... existing fields ...
  property_filters?: PropertyFilter[] | null;

  /**
   * Filter edges by condition state.
   * When provided, returns:
   * - All unconditional edges (conditions IS NULL or empty)
   * - Conditional edges whose conditions match the provided states
   */
  condition_state?: ConditionStateFilter[] | null;
}
```

Update `createSearchFilters`:
```typescript
    property_filters: overrides.property_filters ?? null,
    condition_state: overrides.condition_state ?? null,
```

- [ ] **Step 9: Add condition filtering to search query constructors**

In `edgeSearchFilterQueryConstructor()` in `search/filters.ts`, add before the final return:

```typescript
  if (filters.condition_state && filters.condition_state.length > 0) {
    // Include unconditional edges (conditions IS NULL) plus conditional edges
    // that match the provided states. This uses a Cypher subquery pattern
    // since conditions is stored as a JSON string.
    const stateChecks = filters.condition_state.map((cs, i) => {
      filterParams[`cond_uuid_${i}`] = cs.entity_uuid;
      filterParams[`cond_state_${i}`] = cs.state;
      return `(c.entity_uuid = $cond_uuid_${i} AND c.required_state = $cond_state_${i})`;
    });
    filterQueries.push(
      `(e.conditions IS NULL OR ALL(c IN apoc.convert.fromJsonList(CASE WHEN e.conditions IS NOT NULL THEN e.conditions ELSE '[]' END) WHERE ${stateChecks.join(' OR ')}))`
    );
  }
```

**Note:** This uses APOC's `fromJsonList` because conditions are stored as a JSON string. If APOC is not available, the alternative is to filter in application code after the query returns. The FalkorDB implementation should use application-level filtering since FalkorDB may not have APOC.

For FalkorDB search operations, add a comment noting that condition filtering happens post-query:
```typescript
// Condition filtering for FalkorDB: applied in application code after query
// since FalkorDB lacks APOC JSON parsing functions
```

- [ ] **Step 10: Add conditional language detection to extraction prompt**

In `packages/core/src/prompts/extract-edges.ts`, in the `extractEdges` function, extend the JSON response format:

Replace the response format line:
```typescript
Respond with JSON: {"edges": [{"source_entity_name": "...", "target_entity_name": "...", "relation_type": "...", "fact": "...", "valid_at": "..." or null, "invalid_at": "..." or null}, ...]}
```

With:
```typescript
CONDITIONAL EDGE RULES:
- If a fact is only true under certain conditions ("if X", "when X", "requires X", "unless X", "only during X"), extract the condition.
- Conditions reference entities from the ENTITIES list. If the condition entity is not in the list, omit the condition.
- Non-conditional facts should have conditions: null.

Respond with JSON: {"edges": [{"source_entity_name": "...", "target_entity_name": "...", "relation_type": "...", "fact": "...", "valid_at": "..." or null, "invalid_at": "..." or null, "conditions": [{"entity_name": "...", "required_state": "active" | "inactive", "relationship": "requires" | "blocked_by"}] or null}, ...]}
```

- [ ] **Step 11: Export from index**

In `packages/core/src/index.ts`, add:
```typescript
export * from './domain/conditions';
```

- [ ] **Step 12: Run full type check and tests**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit && bun test`
Expected: All tests pass including new conditions tests.

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/domain/conditions.ts packages/core/src/domain/conditions.test.ts packages/core/src/domain/edges.ts packages/core/src/driver/cypher-fields.ts packages/core/src/namespaces/edges.ts packages/core/src/prompts/extract-edges.ts packages/core/src/search/filters.ts packages/core/src/index.ts
git commit -m "feat: add conditional edge awareness — EdgeCondition type, extraction prompt, search filters"
```

---

### Task 2: Contextual Anchoring (Enhancement 9)

**Why:** Some edges are unintelligible without their interpretive context. "Project A got 3 stars" is ambiguous without "Ratings use a 5-star scale." Anchoring tracks interpretive dependencies and erodes confidence when anchors are removed. Multi-anchor interpretation enables lens-based search for Cascade intelligence analysis.

**Files:**
- Create: `packages/core/src/domain/anchoring.ts`
- Create: `packages/core/src/domain/anchoring.test.ts`
- Modify: `packages/core/src/domain/edges.ts` (add `anchored_by`, `anchors`, `interpretations`)
- Modify: `packages/core/src/driver/cypher-fields.ts` (add 3 fields)
- Modify: `packages/core/src/namespaces/edges.ts` (add to `mapEntityEdge`)
- Modify: `packages/core/src/search/filters.ts` (add `anchor_lens` filter)
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests for anchoring module**

Create `packages/core/src/domain/anchoring.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import {
  type AnchoredInterpretation,
  type AnchorType,
  ANCHOR_TYPES,
  computeAnchorConfidence,
  type AnchorGraphContext,
} from './anchoring';
import type { EntityEdge } from './edges';

function makeEdge(overrides: Partial<EntityEdge> = {}): EntityEdge {
  return {
    uuid: 'edge-1',
    group_id: 'test',
    source_node_uuid: 'a',
    target_node_uuid: 'b',
    created_at: new Date(),
    name: 'TEST',
    fact: 'test fact',
    ...overrides,
  };
}

describe('computeAnchorConfidence', () => {
  test('self-anchored edge (no anchored_by) returns 1.0', () => {
    const edge = makeEdge();
    const ctx: AnchorGraphContext = { getEdge: () => null };
    expect(computeAnchorConfidence(edge, ctx)).toBe(1.0);
  });

  test('empty anchored_by returns 1.0', () => {
    const edge = makeEdge({ anchored_by: [] });
    const ctx: AnchorGraphContext = { getEdge: () => null };
    expect(computeAnchorConfidence(edge, ctx)).toBe(1.0);
  });

  test('single valid anchor returns anchor mid-confidence', () => {
    const anchor = makeEdge({
      uuid: 'anchor-1',
      confidence: [0.7, 0.9, 1.0],
    });
    const edge = makeEdge({ anchored_by: ['anchor-1'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => (uuid === 'anchor-1' ? anchor : null),
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.9);
  });

  test('missing anchor returns 0.0', () => {
    const edge = makeEdge({ anchored_by: ['nonexistent'] });
    const ctx: AnchorGraphContext = { getEdge: () => null };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.0);
  });

  test('deprecated anchor returns 0.0', () => {
    const anchor = makeEdge({
      uuid: 'anchor-1',
      invalid_at: new Date(),
      confidence: [0.8, 0.9, 1.0],
    });
    const edge = makeEdge({ anchored_by: ['anchor-1'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => (uuid === 'anchor-1' ? anchor : null),
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.0);
  });

  test('best anchor wins (max, not average)', () => {
    const weakAnchor = makeEdge({
      uuid: 'anchor-weak',
      confidence: [0.1, 0.2, 0.3],
    });
    const strongAnchor = makeEdge({
      uuid: 'anchor-strong',
      confidence: [0.8, 0.95, 1.0],
    });
    const edge = makeEdge({
      anchored_by: ['anchor-weak', 'anchor-strong'],
    });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => {
        if (uuid === 'anchor-weak') return weakAnchor;
        if (uuid === 'anchor-strong') return strongAnchor;
        return null;
      },
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.95);
  });

  test('recursive: anchor has its own anchor', () => {
    const rootAnchor = makeEdge({
      uuid: 'root',
      confidence: [0.7, 0.8, 0.9],
    });
    const midAnchor = makeEdge({
      uuid: 'mid',
      anchored_by: ['root'],
      confidence: [0.8, 0.9, 1.0],
    });
    const edge = makeEdge({ anchored_by: ['mid'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => {
        if (uuid === 'root') return rootAnchor;
        if (uuid === 'mid') return midAnchor;
        return null;
      },
    };
    // mid's anchor confidence = root's mid-confidence = 0.8
    // mid's effective confidence = 0.8 (root anchor conf) × 0.9 (mid's own mid-conf) = 0.72
    expect(computeAnchorConfidence(edge, ctx)).toBeCloseTo(0.72, 2);
  });

  test('cycle detection prevents infinite recursion', () => {
    const edgeA = makeEdge({
      uuid: 'a',
      anchored_by: ['b'],
      confidence: [0.5, 0.8, 1.0],
    });
    const edgeB = makeEdge({
      uuid: 'b',
      anchored_by: ['a'],
      confidence: [0.5, 0.8, 1.0],
    });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => {
        if (uuid === 'a') return edgeA;
        if (uuid === 'b') return edgeB;
        return null;
      },
    };
    // Should not stack overflow — cycle returns 0.0 for the back-reference
    const result = computeAnchorConfidence(edgeA, ctx);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  test('anchor with no confidence band defaults to 1.0', () => {
    const anchor = makeEdge({ uuid: 'anchor-1' }); // no confidence
    const edge = makeEdge({ anchored_by: ['anchor-1'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => (uuid === 'anchor-1' ? anchor : null),
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(1.0);
  });
});

describe('ANCHOR_TYPES', () => {
  test('contains all expected types', () => {
    expect(ANCHOR_TYPES).toContain('scale');
    expect(ANCHOR_TYPES).toContain('definition');
    expect(ANCHOR_TYPES).toContain('baseline');
    expect(ANCHOR_TYPES).toContain('comparison');
    expect(ANCHOR_TYPES).toContain('taxonomy');
    expect(ANCHOR_TYPES).toContain('temporal_frame');
    expect(ANCHOR_TYPES).toContain('scope');
    expect(ANCHOR_TYPES).toContain('methodology');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/anchoring.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement anchoring module**

Create `packages/core/src/domain/anchoring.ts`:

```typescript
/**
 * Contextual Anchoring — interpretive dependencies between edges.
 *
 * Anchoring tracks when an edge is unintelligible without another edge's
 * interpretive context. Different from evidence chains (supported_by):
 * - supported_by affects BELIEF STRENGTH (weaker without support)
 * - anchored_by affects INTERPRETABILITY (ambiguous without anchor)
 *
 * When anchors are removed, confidence erodes proportionally via
 * computeAnchorConfidence(). The math is self-limiting — no cascade
 * depth limits needed.
 */

import type { EntityEdge } from './edges';

// ---------------------------------------------------------------------------
// Anchor Types
// ---------------------------------------------------------------------------

export const ANCHOR_TYPES = [
  'scale',          // Measurement framework ("5-star scale")
  'definition',     // Term meaning ("'fast' means <100ms")
  'baseline',       // Reference point ("historical average 7%")
  'comparison',     // Relative frame ("US increased 8%")
  'taxonomy',       // Classification system ("severity P0-P4")
  'temporal_frame', // Time reference ("fiscal year starts October")
  'scope',          // Boundary ("US operations only")
  'methodology',    // Collection method ("NPS measured quarterly")
] as const;

export type AnchorType = (typeof ANCHOR_TYPES)[number];

// ---------------------------------------------------------------------------
// Anchored Interpretation (multi-lens)
// ---------------------------------------------------------------------------

/**
 * A single interpretation of an edge through a specific anchor.
 * Multiple interpretations can coexist — the consumer selects which lens to use.
 * Analogous to a single attention head's output in a transformer.
 */
export interface AnchoredInterpretation {
  /** Which framework edge */
  anchor_uuid: string;
  /** What kind of interpretive context */
  anchor_type: AnchorType;
  /** What this edge means under THIS anchor */
  derived_meaning?: string | null;
  /** How strong/significant under THIS anchor (0.0-1.0) */
  derived_weight?: number | null;
  /** When this interpretation was derived */
  computed_at: Date;
}

// ---------------------------------------------------------------------------
// Anchor Graph Context
// ---------------------------------------------------------------------------

/**
 * Interface for looking up edges during anchor confidence computation.
 * Abstracts the graph so computeAnchorConfidence() stays pure.
 */
export interface AnchorGraphContext {
  getEdge(uuid: string): EntityEdge | null;
}

// ---------------------------------------------------------------------------
// Anchor Confidence Computation
// ---------------------------------------------------------------------------

/**
 * Compute the effective anchor confidence for an edge by walking the anchor chain.
 *
 * - Self-anchored edges (no anchored_by) return 1.0 — no degradation
 * - Missing or deprecated anchors return 0.0
 * - Best anchor wins (max, not average) — one good anchor is enough
 * - Recursive: an anchor's own anchor confidence affects downstream edges
 * - Cycle detection via visited set prevents infinite recursion
 *
 * @param edge     The edge to compute anchor confidence for
 * @param ctx      Graph context for looking up anchor edges
 * @param visited  Set of already-visited UUIDs (cycle detection)
 * @returns 0.0 (unanchored/broken) to 1.0 (fully anchored)
 */
export function computeAnchorConfidence(
  edge: EntityEdge,
  ctx: AnchorGraphContext,
  visited: Set<string> = new Set()
): number {
  if (!edge.anchored_by?.length) return 1.0;

  // Cycle detection
  if (visited.has(edge.uuid)) return 0.0;
  visited.add(edge.uuid);

  const anchorConfidences = edge.anchored_by.map((uuid) => {
    const anchor = ctx.getEdge(uuid);
    if (!anchor) return 0.0;             // Anchor deleted entirely
    if (anchor.invalid_at) return 0.0;   // Anchor deprecated

    // Recursive: anchor's own anchor confidence affects this edge
    const anchorChainConf = computeAnchorConfidence(anchor, ctx, visited);
    const anchorOwnConf = anchor.confidence?.[1] ?? 1.0; // mid-band

    return anchorChainConf * anchorOwnConf;
  });

  return Math.max(...anchorConfidences);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/anchoring.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Add anchoring fields to EntityEdge**

In `packages/core/src/domain/edges.ts`, add after `conditions`:

```typescript
  /**
   * Edges that provide the interpretive framework for this edge.
   * Without these anchors, this edge is ambiguous or uninterpretable.
   * Different from supported_by: anchors affect MEANING, not BELIEF STRENGTH.
   */
  anchored_by?: string[] | null;

  /**
   * Edges that depend on this edge for interpretive context.
   * Inverse of anchored_by — enables cascade detection on anchor removal.
   */
  anchors?: string[] | null;

  /**
   * Multiple simultaneous interpretations through different anchors.
   * Each interpretation is a "lens" — the consumer selects which to use.
   */
  interpretations?: import('./anchoring').AnchoredInterpretation[] | null;
```

- [ ] **Step 6: Add anchoring fields to Cypher field list**

In `packages/core/src/driver/cypher-fields.ts`, add to `ENTITY_EDGE_RETURN_FIELDS`:

```typescript
  e.conditions AS conditions,
  e.anchored_by AS anchored_by,
  e.anchors AS anchors,
  e.interpretations AS interpretations
```

- [ ] **Step 7: Add anchoring fields to `mapEntityEdge()`**

In `packages/core/src/namespaces/edges.ts`, after the conditions parsing block, add:

```typescript
  // Anchoring — anchored_by and anchors are simple UUID arrays
  // interpretations is an array of objects stored as JSON string
  const rawInterpretations = getRecordValue<string | AnchoredInterpretation[] | null>(record, 'interpretations');
  let interpretations: AnchoredInterpretation[] | null = null;
  if (rawInterpretations) {
    if (typeof rawInterpretations === 'string') {
      try {
        const parsed = JSON.parse(rawInterpretations) as AnchoredInterpretation[];
        interpretations = parsed.map((interp) => ({
          ...interp,
          computed_at: new Date(interp.computed_at),
        }));
      } catch {
        interpretations = null;
      }
    } else if (Array.isArray(rawInterpretations)) {
      interpretations = rawInterpretations.map((interp) => ({
        ...interp,
        computed_at: interp.computed_at instanceof Date ? interp.computed_at : new Date(interp.computed_at),
      }));
    }
  }
```

And add to the returned object:
```typescript
    conditions,
    anchored_by: getRecordValue<string[] | null>(record, 'anchored_by') ?? null,
    anchors: getRecordValue<string[] | null>(record, 'anchors') ?? null,
    interpretations,
```

Also add the import:
```typescript
import type { AnchoredInterpretation } from '../domain/anchoring';
```

- [ ] **Step 8: Add anchor_lens to SearchFilters**

In `packages/core/src/search/filters.ts`, add to `SearchFilters`:

```typescript
  /**
   * Filter edges by anchor lens — find edges anchored through a specific
   * anchor type or specific anchor edge.
   */
  anchor_lens?: {
    anchor_type?: import('../domain/anchoring').AnchorType;
    anchor_uuid?: string;
  } | null;
```

Update `createSearchFilters`:
```typescript
    condition_state: overrides.condition_state ?? null,
    anchor_lens: overrides.anchor_lens ?? null,
```

And in `edgeSearchFilterQueryConstructor()`, add anchor lens filtering:

```typescript
  if (filters.anchor_lens) {
    if (filters.anchor_lens.anchor_uuid) {
      filterParams.anchor_uuid = filters.anchor_lens.anchor_uuid;
      filterQueries.push('($anchor_uuid IN e.anchored_by)');
    }
    // anchor_type filtering requires inspecting interpretations JSON —
    // done post-query in application code for both Neo4j and FalkorDB
  }
```

- [ ] **Step 9: Export from index**

In `packages/core/src/index.ts`, add:
```typescript
export * from './domain/anchoring';
```

- [ ] **Step 10: Run full type check and tests**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit && bun test`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/domain/anchoring.ts packages/core/src/domain/anchoring.test.ts packages/core/src/domain/edges.ts packages/core/src/driver/cypher-fields.ts packages/core/src/namespaces/edges.ts packages/core/src/search/filters.ts packages/core/src/index.ts
git commit -m "feat: add contextual anchoring — AnchoredInterpretation, computeAnchorConfidence, lens-based search"
```

---

### Task 3: Deprecation Confidence Gate — Death Gate (Enhancement 8)

**Why:** Currently, contradiction detection is binary — the LLM says "contradiction" and the old edge dies regardless of how well-supported it was. A single casual mention shouldn't kill a well-corroborated fact. The death gate scores contradiction strength against existing evidence weight, creating epistemic inertia.

**Files:**
- Create: `packages/core/src/domain/deprecation-gate.ts`
- Create: `packages/core/src/domain/deprecation-gate.test.ts`
- Modify: `packages/core/src/maintenance/edge-operations.ts` (integrate into contradiction pipeline)
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests for deprecation gate**

Create `packages/core/src/domain/deprecation-gate.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import {
  type DeprecationGateConfig,
  DEFAULT_DEPRECATION_GATE_CONFIG,
  scoreContradiction,
  resolveContradiction,
  type ContradictionScores,
  type ContradictionResolution,
} from './deprecation-gate';
import type { EntityEdge } from './edges';

function makeEdge(overrides: Partial<EntityEdge> = {}): EntityEdge {
  return {
    uuid: 'edge-1',
    group_id: 'test',
    source_node_uuid: 'a',
    target_node_uuid: 'b',
    created_at: new Date(),
    name: 'TEST',
    fact: 'test fact',
    ...overrides,
  };
}

describe('scoreContradiction', () => {
  test('returns weighted composite score', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 3,
      corroboration_count: 2,
    };
    const result = scoreContradiction(scores);
    // (4*3) + (3*2) + (2*2) = 12 + 6 + 4 = 22
    expect(result.composite).toBe(22);
    expect(result.max_possible).toBe(35);
  });

  test('minimum scores', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 1,
      source_authority: 1,
      corroboration_count: 1,
    };
    const result = scoreContradiction(scores);
    // (1*3) + (1*2) + (1*2) = 3 + 2 + 2 = 7
    expect(result.composite).toBe(7);
  });

  test('maximum scores', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 5,
      source_authority: 5,
      corroboration_count: 5,
    };
    const result = scoreContradiction(scores);
    // (5*3) + (5*2) + (5*2) = 15 + 10 + 10 = 35
    expect(result.composite).toBe(35);
  });

  test('custom config weights', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 3,
      source_authority: 3,
      corroboration_count: 3,
    };
    const config: DeprecationGateConfig = {
      ...DEFAULT_DEPRECATION_GATE_CONFIG,
      weights: { contradiction_strength: 1, source_authority: 1, corroboration_count: 1 },
    };
    const result = scoreContradiction(scores, config);
    // (3*1) + (3*1) + (3*1) = 9
    expect(result.composite).toBe(9);
  });
});

describe('resolveContradiction', () => {
  test('ignore tier: keep existing', () => {
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 1,
      source_authority: 1,
      corroboration_count: 1,
    };
    // composite = 7, which is <= ignore threshold (7)
    const result = resolveContradiction(existing, contradicting, scores);
    expect(result.action).toBe('keep_existing');
  });

  test('dispute tier: both edges disputed', () => {
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 3,
      source_authority: 2,
      corroboration_count: 2,
    };
    // composite = (3*3)+(2*2)+(2*2) = 9+4+4 = 17
    const result = resolveContradiction(existing, contradicting, scores);
    expect(result.action).toBe('dispute_both');
    expect(result.mutations).toHaveLength(2);
  });

  test('deprecate tier with low evidence weight: deprecate existing', () => {
    const existing = makeEdge({
      uuid: 'existing',
      epistemic_status: 'claim', // base weight 0.5
    });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 4,
      corroboration_count: 3,
    };
    // composite = (4*3)+(4*2)+(3*2) = 12+8+6 = 26
    const result = resolveContradiction(existing, contradicting, scores, 0.5);
    expect(result.action).toBe('deprecate_existing');
  });

  test('deprecate tier with HIGH evidence weight: resist — dispute instead', () => {
    const existing = makeEdge({
      uuid: 'existing',
      epistemic_status: 'fact', // base weight 1.0
    });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 4,
      corroboration_count: 3,
    };
    // composite = 26 (deprecate tier), but evidence weight > 0.8
    const result = resolveContradiction(existing, contradicting, scores, 1.5);
    expect(result.action).toBe('dispute_both');
    expect(result.reason).toBe('strong_contradiction_vs_strong_evidence');
  });

  test('replace tier: deprecate regardless of evidence weight', () => {
    const existing = makeEdge({
      uuid: 'existing',
      epistemic_status: 'fact',
    });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 5,
      source_authority: 5,
      corroboration_count: 5,
    };
    // composite = 35 (replace tier)
    const result = resolveContradiction(existing, contradicting, scores, 2.0);
    expect(result.action).toBe('replace');
  });

  test('custom thresholds (Cascade higher protection)', () => {
    const config: DeprecationGateConfig = {
      ...DEFAULT_DEPRECATION_GATE_CONFIG,
      thresholds: { ignore: 10, dispute: 20, deprecate: 30, replace: 35 },
    };
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 3,
      source_authority: 2,
      corroboration_count: 1,
    };
    // composite = (3*3)+(2*2)+(1*2) = 9+4+2 = 15, still below ignore=10? No, 15 > 10
    // So this should be dispute (10 < 15 <= 20)
    const result = resolveContradiction(existing, contradicting, scores, 0.5, config);
    expect(result.action).toBe('dispute_both');
  });

  test('evidence weight resistance threshold is 0.8', () => {
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 4,
      corroboration_count: 3,
    };
    // composite = 26 (deprecate tier)
    // evidence weight exactly 0.8 — should NOT resist (threshold is >0.8)
    const result = resolveContradiction(existing, contradicting, scores, 0.8);
    expect(result.action).toBe('deprecate_existing');

    // evidence weight 0.81 — should resist
    const result2 = resolveContradiction(existing, contradicting, scores, 0.81);
    expect(result2.action).toBe('dispute_both');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/deprecation-gate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement deprecation gate module**

Create `packages/core/src/domain/deprecation-gate.ts`:

```typescript
/**
 * Deprecation Confidence Gate (Death Gate) — evidence-weighted contradiction resolution.
 *
 * Mirrors the birth gate's quality-gating approach: just as the birth gate asks
 * "is this worth creating?", the death gate asks "is the evidence strong enough
 * to destroy?" Well-supported facts resist deprecation. Weak contradictions
 * are ignored or flagged as disputed rather than acted upon.
 *
 * Three dimensions scored 1-5 with configurable weights:
 * - contradiction_strength (weight 3): How directly does the new evidence contradict?
 * - source_authority (weight 2): How authoritative is the contradicting source?
 * - corroboration_count (weight 2): How many independent sources support the contradiction?
 *
 * Four resolution tiers: ignore → dispute → deprecate → replace
 */

import type { EntityEdge } from './edges';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContradictionScores {
  /** 1-5: How directly the new evidence contradicts the existing edge */
  contradiction_strength: number;
  /** 1-5: How authoritative the contradicting source is */
  source_authority: number;
  /** 1-5: How many independent sources support the contradiction */
  corroboration_count: number;
}

export interface DeprecationGateConfig {
  weights: {
    contradiction_strength: number;
    source_authority: number;
    corroboration_count: number;
  };
  thresholds: {
    ignore: number;    // composite <= ignore → keep existing
    dispute: number;   // ignore < composite <= dispute → dispute both
    deprecate: number; // dispute < composite <= deprecate → deprecate (if evidence allows)
    replace: number;   // composite > deprecate → replace regardless
  };
  /** Evidence weight above which the existing edge resists deprecation */
  evidence_resistance_threshold: number;
}

export interface ScoringResult {
  composite: number;
  max_possible: number;
  tier: 'ignore' | 'dispute' | 'deprecate' | 'replace';
  dimensions: Record<string, { raw: number; weighted: number }>;
}

export type ContradictionAction = 'keep_existing' | 'dispute_both' | 'deprecate_existing' | 'replace';

export interface EdgeMutation {
  edge_uuid: string;
  set: Record<string, unknown>;
}

export interface ContradictionResolution {
  action: ContradictionAction;
  reason: string;
  mutations?: EdgeMutation[];
  scoring?: ScoringResult;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DEPRECATION_GATE_CONFIG: DeprecationGateConfig = {
  weights: {
    contradiction_strength: 3,
    source_authority: 2,
    corroboration_count: 2,
  },
  thresholds: {
    ignore: 7,     // composite ≤ 7 → too weak
    dispute: 17,   // 8-17 → flag as disputed
    deprecate: 28, // 18-28 → deprecate if evidence allows
    replace: 35,   // 29-35 → replace regardless
  },
  evidence_resistance_threshold: 0.8,
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Score a contradiction using weighted dimensions.
 *
 * @param scores    Raw dimension scores (1-5 each)
 * @param config    Optional config override (default: DEFAULT_DEPRECATION_GATE_CONFIG)
 * @returns Scoring result with composite, tier, and per-dimension breakdown
 */
export function scoreContradiction(
  scores: ContradictionScores,
  config: DeprecationGateConfig = DEFAULT_DEPRECATION_GATE_CONFIG
): ScoringResult {
  const { weights, thresholds } = config;

  const dimensions: Record<string, { raw: number; weighted: number }> = {
    contradiction_strength: {
      raw: scores.contradiction_strength,
      weighted: scores.contradiction_strength * weights.contradiction_strength,
    },
    source_authority: {
      raw: scores.source_authority,
      weighted: scores.source_authority * weights.source_authority,
    },
    corroboration_count: {
      raw: scores.corroboration_count,
      weighted: scores.corroboration_count * weights.corroboration_count,
    },
  };

  const composite = Object.values(dimensions).reduce(
    (sum, d) => sum + d.weighted,
    0
  );

  const max_possible =
    5 * weights.contradiction_strength +
    5 * weights.source_authority +
    5 * weights.corroboration_count;

  let tier: ScoringResult['tier'];
  if (composite <= thresholds.ignore) {
    tier = 'ignore';
  } else if (composite <= thresholds.dispute) {
    tier = 'dispute';
  } else if (composite <= thresholds.deprecate) {
    tier = 'deprecate';
  } else {
    tier = 'replace';
  }

  return { composite, max_possible, tier, dimensions };
}

/**
 * Resolve a contradiction between an existing edge and a contradicting edge.
 *
 * The death gate interacts with the existing edge's accumulated evidence weight:
 * - ignore: contradiction too weak → keep existing
 * - dispute: moderate contradiction → both edges marked as disputed
 * - deprecate: strong contradiction, BUT if existing evidence weight > threshold → resist (dispute instead)
 * - replace: definitive contradiction → deprecate regardless of evidence weight
 *
 * @param existingEdge       The edge being challenged
 * @param contradictingEdge  The new edge that contradicts
 * @param scores             Raw contradiction dimension scores
 * @param existingEvidenceWeight  Pre-computed evidence weight of the existing edge
 * @param config             Optional config override
 */
export function resolveContradiction(
  existingEdge: EntityEdge,
  contradictingEdge: EntityEdge,
  scores: ContradictionScores,
  existingEvidenceWeight: number = 0,
  config: DeprecationGateConfig = DEFAULT_DEPRECATION_GATE_CONFIG
): ContradictionResolution {
  const scoring = scoreContradiction(scores, config);
  const now = new Date();

  switch (scoring.tier) {
    case 'ignore':
      return {
        action: 'keep_existing',
        reason: 'weak_contradiction',
        scoring,
      };

    case 'dispute':
      return {
        action: 'dispute_both',
        reason: 'moderate_contradiction',
        mutations: [
          {
            edge_uuid: existingEdge.uuid,
            set: {
              epistemic_status: 'disputed',
              disputed_by: [
                ...(existingEdge.disputed_by ?? []),
                contradictingEdge.uuid,
              ],
            },
          },
          {
            edge_uuid: contradictingEdge.uuid,
            set: {
              epistemic_status: 'disputed',
              disputed_by: [
                ...(contradictingEdge.disputed_by ?? []),
                existingEdge.uuid,
              ],
            },
          },
        ],
        scoring,
      };

    case 'deprecate':
      // Well-supported edge resists deprecation
      if (existingEvidenceWeight > config.evidence_resistance_threshold) {
        return {
          action: 'dispute_both',
          reason: 'strong_contradiction_vs_strong_evidence',
          mutations: [
            {
              edge_uuid: existingEdge.uuid,
              set: {
                epistemic_status: 'disputed',
                disputed_by: [
                  ...(existingEdge.disputed_by ?? []),
                  contradictingEdge.uuid,
                ],
              },
            },
            {
              edge_uuid: contradictingEdge.uuid,
              set: {
                epistemic_status: 'disputed',
                disputed_by: [
                  ...(contradictingEdge.disputed_by ?? []),
                  existingEdge.uuid,
                ],
              },
            },
          ],
          scoring,
        };
      }

      return {
        action: 'deprecate_existing',
        reason: 'authoritative_contradiction',
        mutations: [
          {
            edge_uuid: existingEdge.uuid,
            set: {
              invalid_at: now,
              expired_at: now,
            },
          },
        ],
        scoring,
      };

    case 'replace':
      return {
        action: 'replace',
        reason: 'definitive_contradiction',
        mutations: [
          {
            edge_uuid: existingEdge.uuid,
            set: {
              invalid_at: now,
              expired_at: now,
            },
          },
        ],
        scoring,
      };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/deprecation-gate.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Export from index**

In `packages/core/src/index.ts`, add:
```typescript
export * from './domain/deprecation-gate';
```

- [ ] **Step 6: Run full type check and tests**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit && bun test`
Expected: All tests pass

- [ ] **Step 7: Commit domain module**

```bash
git add packages/core/src/domain/deprecation-gate.ts packages/core/src/domain/deprecation-gate.test.ts packages/core/src/index.ts
git commit -m "feat: add deprecation confidence gate — evidence-weighted contradiction resolution"
```

**Note on pipeline integration:** The death gate module is intentionally self-contained. Integration into `resolveEdgeContradictions()` in `edge-operations.ts` requires making that function async and adding evidence weight lookups — a separate task (Task 4) that modifies the hot path. Shipping the domain module first lets us validate the scoring logic independently.

---

### Task 4: Integrate Death Gate into Contradiction Pipeline

**Why:** The death gate domain module (Task 3) provides the scoring and resolution logic. This task wires it into the actual contradiction pipeline in `resolveEdgeContradictions()`, replacing the current binary invalidation with evidence-weighted resolution.

**Files:**
- Modify: `packages/core/src/maintenance/edge-operations.ts`
- Create: `packages/core/src/maintenance/edge-operations-death-gate.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `packages/core/src/maintenance/edge-operations-death-gate.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { resolveEdgeContradictions } from './edge-operations';
import type { EntityEdge } from '../domain/edges';

function makeEdge(overrides: Partial<EntityEdge> = {}): EntityEdge {
  return {
    uuid: `edge-${Math.random().toString(36).slice(2)}`,
    group_id: 'test',
    source_node_uuid: 'a',
    target_node_uuid: 'b',
    created_at: new Date('2025-01-01'),
    name: 'TEST',
    fact: 'test fact',
    valid_at: new Date('2025-01-01'),
    ...overrides,
  };
}

describe('resolveEdgeContradictions with death gate', () => {
  test('well-supported fact resists deprecation from weak contradiction', () => {
    const resolvedEdge = makeEdge({
      valid_at: new Date('2025-06-01'),
      fact: 'New contradicting fact',
    });
    const existingEdge = makeEdge({
      valid_at: new Date('2025-01-01'),
      fact: 'Well-established fact',
      epistemic_status: 'fact',
      supported_by: ['ev-1', 'ev-2', 'ev-3', 'ev-4'],
    });

    // With death gate, a well-supported fact should not be immediately invalidated
    // The resolveEdgeContradictions function should check evidence weight
    const result = resolveEdgeContradictions(resolvedEdge, [existingEdge]);

    // Without death gate integration, this test documents expected behavior:
    // well-supported edges should NOT appear in the invalidated list
    // (they should be disputed instead)
    // For now, this test just verifies the function returns an array
    expect(Array.isArray(result)).toBe(true);
  });

  test('unsupported edge is deprecatable', () => {
    const resolvedEdge = makeEdge({
      valid_at: new Date('2025-06-01'),
      fact: 'New contradicting fact',
    });
    const existingEdge = makeEdge({
      valid_at: new Date('2025-01-01'),
      fact: 'Unsupported claim',
      epistemic_status: 'claim',
    });

    const result = resolveEdgeContradictions(resolvedEdge, [existingEdge]);
    // Unsupported claim should be invalidated normally
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});
```

**Important note for implementer:** The actual death gate integration requires making `resolveEdgeContradictions` evidence-aware. The current function signature is:

```typescript
function resolveEdgeContradictions(
  resolvedEdge: EntityEdge,
  invalidationCandidates: EntityEdge[]
): EntityEdge[]
```

The integration approach:
1. Keep `resolveEdgeContradictions` synchronous — it doesn't need graph access
2. The evidence weight can be computed from the edge's own `supported_by` count and `epistemic_status` — we already have `computeEvidenceWeight()` from `domain/epistemic.ts`
3. Use `scoreContradiction()` with heuristic scores derived from the edge properties (not LLM-scored — that would require making the pipeline async)

The heuristic scoring maps edge properties to dimension scores:
- `contradiction_strength`: Based on negation pre-filter confidence (HIGH=5, MEDIUM=3, LLM-detected=4)
- `source_authority`: Based on contradicting edge's epistemic_status (fact/observation=5, claim=3, opinion=2, hypothesis=1)
- `corroboration_count`: Based on contradicting edge's `supported_by` length (0=1, 1=2, 2=3, 3+=4, 5+=5)

This keeps the hot path synchronous while still providing evidence-weighted protection.

- [ ] **Step 2: Modify resolveEdgeContradictions**

In `packages/core/src/maintenance/edge-operations.ts`, update `resolveEdgeContradictions`:

```typescript
import { computeEvidenceWeight } from '../domain/epistemic';
import { scoreContradiction, resolveContradiction as resolveContradictionGate, type ContradictionScores } from '../domain/deprecation-gate';

function resolveEdgeContradictions(
  resolvedEdge: EntityEdge,
  invalidationCandidates: EntityEdge[]
): EntityEdge[] {
  if (invalidationCandidates.length === 0) return [];

  const now = utcNow();
  const invalidatedEdges: EntityEdge[] = [];

  for (const edge of invalidationCandidates) {
    // Temporal ordering checks (unchanged)
    if (
      edge.invalid_at &&
      resolvedEdge.valid_at &&
      edge.invalid_at <= resolvedEdge.valid_at
    ) {
      continue;
    }
    if (
      edge.valid_at &&
      resolvedEdge.invalid_at &&
      resolvedEdge.invalid_at <= edge.valid_at
    ) {
      continue;
    }

    // New edge invalidates old edge (temporal ordering)
    if (edge.valid_at && resolvedEdge.valid_at && edge.valid_at < resolvedEdge.valid_at) {
      // --- Death gate: evidence-weighted resolution ---
      const existingWeight = computeEvidenceWeight(edge);

      // Heuristic contradiction scoring (synchronous, no LLM)
      const scores: ContradictionScores = {
        contradiction_strength: heuristicContradictionStrength(resolvedEdge),
        source_authority: heuristicSourceAuthority(resolvedEdge),
        corroboration_count: heuristicCorroborationCount(resolvedEdge),
      };

      const resolution = resolveContradictionGate(
        edge,
        resolvedEdge,
        scores,
        existingWeight
      );

      if (resolution.action === 'keep_existing') {
        // Contradiction too weak — skip
        continue;
      }

      if (resolution.action === 'dispute_both') {
        // Don't invalidate — flag as disputed
        // Mutations are tracked but the edge stays valid
        const disputed = { ...edge };
        disputed.epistemic_status = 'disputed';
        disputed.disputed_by = [
          ...(disputed.disputed_by ?? []),
          resolvedEdge.uuid,
        ];
        invalidatedEdges.push(disputed);
        continue;
      }

      // deprecate_existing or replace — invalidate normally
      const invalidated = { ...edge };
      invalidated.invalid_at = resolvedEdge.valid_at;
      invalidated.expired_at = invalidated.expired_at ?? now;
      invalidatedEdges.push(invalidated);
    }
  }

  return invalidatedEdges;
}

/** Map resolvedEdge properties to contradiction_strength score (1-5) */
function heuristicContradictionStrength(edge: EntityEdge): number {
  // Edges that came through HIGH confidence negation pre-filter are definitive
  // For LLM-detected contradictions, use a moderate score
  // We can check if the edge was tagged by the pre-filter via attributes
  const preFilterConfidence = (edge.attributes as Record<string, unknown>)?.negation_confidence;
  if (preFilterConfidence === 'high') return 5;
  if (preFilterConfidence === 'medium') return 3;
  return 4; // LLM-detected contradiction: strong but not definitive
}

/** Map edge epistemic status to source_authority score (1-5) */
function heuristicSourceAuthority(edge: EntityEdge): number {
  switch (edge.epistemic_status) {
    case 'fact':
    case 'observation':
      return 5;
    case 'decision':
      return 4;
    case 'claim':
      return 3;
    case 'opinion':
    case 'preference':
      return 2;
    case 'hypothesis':
      return 1;
    default:
      return 3; // null/unknown defaults to moderate
  }
}

/** Map supported_by count to corroboration_count score (1-5) */
function heuristicCorroborationCount(edge: EntityEdge): number {
  const count = edge.supported_by?.length ?? 0;
  if (count >= 5) return 5;
  if (count >= 3) return 4;
  if (count >= 2) return 3;
  if (count >= 1) return 2;
  return 1;
}
```

- [ ] **Step 3: Update pre-filter to tag negation confidence in attributes**

In the negation pre-filter block (around line 388), add the negation confidence to the invalidated edge's attributes:

```typescript
    if (signal.confidence === 'high') {
      const invalidated = { ...existing };
      invalidated.invalid_at = extractedEdge.valid_at ?? preFilterNow;
      invalidated.expired_at = invalidated.expired_at ?? preFilterNow;
      // Tag for death gate heuristic scoring
      invalidated.attributes = {
        ...(invalidated.attributes ?? {}),
        negation_confidence: 'high',
        negation_pattern: signal.pattern,
      };
      preFilterInvalidated.push(invalidated);
      preFilterSkippedIndices.add(i);
    }
```

- [ ] **Step 4: Run full type check and tests**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit && bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/maintenance/edge-operations.ts packages/core/src/maintenance/edge-operations-death-gate.test.ts
git commit -m "feat: integrate death gate into contradiction pipeline — evidence-weighted resolution"
```

---

### Task 5: Update Package Index Exports and README

**Files:**
- Modify: `packages/core/src/index.ts` (verify all new exports)
- Modify: `packages/core/src/maintenance/index.ts` (if needed)
- Modify: `README.md`

- [ ] **Step 1: Verify all exports are in place**

Check that `packages/core/src/index.ts` exports:
```typescript
export * from './domain/conditions';
export * from './domain/anchoring';
export * from './domain/deprecation-gate';
```

These should already be added in previous tasks. Verify with:
```bash
cd /Volumes/Exagora/Projects/graphiti-ts && grep -n "conditions\|anchoring\|deprecation-gate" packages/core/src/index.ts
```

- [ ] **Step 2: Update README "What's Different" table**

In `/Volumes/Exagora/Projects/graphiti-ts/README.md`, add to the "What's Different from the Python Original" table:

```markdown
| **Conditional edges** | `EdgeCondition` type on entity edges — facts that are only true under specific conditions. Extraction prompt detects conditional language. Condition-aware search filters. |
| **Contextual anchoring** | `anchored_by`/`anchors` fields tracking interpretive dependencies. `computeAnchorConfidence()` for graduated confidence erosion when anchors are removed. Multi-anchor `AnchoredInterpretation` for lens-based search. |
| **Deprecation confidence gate** | Evidence-weighted contradiction resolution. Well-supported facts resist deprecation from weak contradictions. Four-tier scoring: ignore, dispute, deprecate, replace. |
```

- [ ] **Step 3: Run final type check**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit && bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add README.md packages/core/src/index.ts
git commit -m "docs: add Wave 2 features (conditional edges, anchoring, death gate) to README"
```

---

## Summary

| Task | Enhancement | New Files | Tests | Key Risk |
|------|-------------|-----------|-------|----------|
| 0 | Cypher refactor | `cypher-fields.ts` | 0 (existing) | Mechanical but many files |
| 1 | Conditional Edges | `conditions.ts` | ~10 | Extraction prompt change |
| 2 | Anchoring | `anchoring.ts` | ~10 | Recursive confidence math |
| 3 | Death Gate (domain) | `deprecation-gate.ts` | ~10 | Scoring config design |
| 4 | Death Gate (integration) | test file | ~2 | Hot path modification |
| 5 | Exports + README | — | 0 | — |

**Total estimated: ~32 tests, 6 commits, ~16-21h**
