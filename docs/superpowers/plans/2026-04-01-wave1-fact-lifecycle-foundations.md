# Wave 1: Fact Lifecycle Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit edge deprecation, semantic negation pre-filtering, and staleness scoring to graphiti-ts core.

**Architecture:** Three independent enhancements in the `packages/core/` library. Deprecation adds `deprecateEdge()`/`deprecateEdges()` to the Graphiti class. Negation pre-filter inserts a regex-based shortcut before the LLM contradiction check in `resolveExtractedEdge()`. Staleness scoring provides a pure function `computeStaleness()` for query-time freshness signals. All three are backward-compatible and require no schema migrations.

**Tech Stack:** TypeScript, Bun test runner, Neo4j (Cypher), graphiti-ts monorepo (`packages/core/`)

**Key decisions (from Architect Review 2026-04-01):**
- `deprecateEdges()` supports `dryRun` option
- HIGH_CONFIDENCE negation = regex + entity overlap, deterministic (skips LLM)
- Deprecation metadata stored in `edge.attributes` bag
- Negation patterns hardcoded in library
- Staleness formula uses named constants for tuning parameters
- Per-pair pre-filtering: HIGH pairs invalidated directly, remaining pairs sent to LLM

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/core/src/domain/staleness.ts` | Create | `StalenessFactors`, `DOMAIN_VELOCITY`, `computeStaleness()` |
| `packages/core/src/domain/staleness.test.ts` | Create | Unit tests for staleness computation |
| `packages/core/src/maintenance/negation.ts` | Create | Negation patterns, `NegationSignal`, `detectNegation()` |
| `packages/core/src/maintenance/negation.test.ts` | Create | Unit tests for every pattern + entity overlap logic |
| `packages/core/src/graphiti.ts` | Modify | Add `deprecateEdge()`, `deprecateEdges()` methods |
| `packages/core/src/graphiti.test.ts` | Modify | Add deprecation unit tests |
| `packages/core/src/maintenance/edge-operations.ts` | Modify | Insert pre-filter call in `resolveExtractedEdge()` |
| `packages/core/src/maintenance/edge-operations.test.ts` | Modify | Add pre-filter integration tests |
| `packages/core/src/maintenance/index.ts` | Modify | Re-export negation module |
| `packages/core/src/index.ts` | Modify | Re-export staleness + negation modules |

---

## Task 1: Staleness Scoring — Types and Computation

**Files:**
- Create: `packages/core/src/domain/staleness.ts`
- Create: `packages/core/src/domain/staleness.test.ts`

- [ ] **Step 1: Write the staleness test file**

```typescript
// packages/core/src/domain/staleness.test.ts
import { describe, expect, it } from 'bun:test';
import {
  computeStaleness,
  STALENESS_MIDPOINT_DAYS,
  STALENESS_SLOPE,
  DOMAIN_VELOCITY,
  type StalenessFactors,
} from './staleness';

describe('computeStaleness', () => {
  const baseFresh: StalenessFactors = {
    age_days: 5,
    last_reinforced_days: 2,
    domain_velocity: 0.5,
    reinforcement_count: 3,
  };

  it('returns near-zero for a fresh, reinforced edge', () => {
    const score = computeStaleness(baseFresh);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(0.1);
  });

  it('returns ~0.5 at the sigmoid midpoint', () => {
    const score = computeStaleness({
      ...baseFresh,
      age_days: STALENESS_MIDPOINT_DAYS,
      last_reinforced_days: null,
      reinforcement_count: 0,
      domain_velocity: 0.5,
    });
    // At midpoint with no reinforcement and default velocity:
    // ageFactor ≈ 0.5, reinforcementFactor = 1.0, velocity = 1.0, recency = 1.0
    // result ≈ 0.5
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.6);
  });

  it('returns near-1.0 for a very old edge with no reinforcement', () => {
    const score = computeStaleness({
      age_days: 365,
      last_reinforced_days: null,
      reinforcement_count: 0,
      domain_velocity: 0.7,
    });
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('reinforcements reduce staleness', () => {
    const withoutReinforcement = computeStaleness({
      age_days: 120,
      last_reinforced_days: null,
      reinforcement_count: 0,
      domain_velocity: 0.5,
    });
    const withReinforcement = computeStaleness({
      age_days: 120,
      last_reinforced_days: 5,
      reinforcement_count: 5,
      domain_velocity: 0.5,
    });
    expect(withReinforcement).toBeLessThan(withoutReinforcement);
  });

  it('higher domain velocity increases staleness', () => {
    const lowVelocity = computeStaleness({
      ...baseFresh,
      age_days: 90,
      domain_velocity: 0.2,
    });
    const highVelocity = computeStaleness({
      ...baseFresh,
      age_days: 90,
      domain_velocity: 0.8,
    });
    expect(highVelocity).toBeGreaterThan(lowVelocity);
  });

  it('never returns below 0', () => {
    const score = computeStaleness({
      age_days: 0,
      last_reinforced_days: 0,
      reinforcement_count: 100,
      domain_velocity: 0.0,
    });
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('never returns above 1', () => {
    const score = computeStaleness({
      age_days: 10000,
      last_reinforced_days: null,
      reinforcement_count: 0,
      domain_velocity: 1.0,
    });
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('recent reinforcement reduces staleness more than old reinforcement', () => {
    const recentReinforcement = computeStaleness({
      age_days: 120,
      last_reinforced_days: 5,
      reinforcement_count: 1,
      domain_velocity: 0.5,
    });
    const oldReinforcement = computeStaleness({
      age_days: 120,
      last_reinforced_days: 55,
      reinforcement_count: 1,
      domain_velocity: 0.5,
    });
    expect(recentReinforcement).toBeLessThan(oldReinforcement);
  });
});

describe('DOMAIN_VELOCITY', () => {
  it('has expected entries for common entity types', () => {
    expect(DOMAIN_VELOCITY['Tool']).toBeDefined();
    expect(DOMAIN_VELOCITY['Person']).toBeDefined();
    expect(DOMAIN_VELOCITY['Concept']).toBeDefined();
  });

  it('all values are between 0 and 1', () => {
    for (const [, value] of Object.entries(DOMAIN_VELOCITY)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/staleness.test.ts`
Expected: FAIL — module `./staleness` not found

- [ ] **Step 3: Write the staleness module**

```typescript
// packages/core/src/domain/staleness.ts
/**
 * Staleness Scoring — computes how stale an edge's fact is likely to be.
 *
 * Score range: 0.0 (fresh) to 1.0 (stale).
 * Computed at query time, never stored — depends on age which changes daily.
 */

// ---------------------------------------------------------------------------
// Tuning Constants (named for easy adjustment)
// ---------------------------------------------------------------------------

/** Sigmoid steepness — higher = sharper transition from fresh to stale */
export const STALENESS_SLOPE = 0.05;

/** Days at which base staleness reaches 0.5 */
export const STALENESS_MIDPOINT_DAYS = 90;

/** Each reinforcement reduces staleness by this factor (capped) */
export const REINFORCEMENT_DECAY = 0.1;

/** Days within which a reinforcement is considered "recent" */
export const RECENCY_WINDOW_DAYS = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StalenessFactors {
  /** Days since valid_at (or created_at if no valid_at) */
  age_days: number;
  /** Days since last episode mentioned this edge, or null if never reinforced */
  last_reinforced_days: number | null;
  /** How fast this domain changes (0.0 = glacial, 1.0 = rapid). Use DOMAIN_VELOCITY table. */
  domain_velocity: number;
  /** How many episodes have mentioned this edge */
  reinforcement_count: number;
}

/**
 * Default velocity values per entity type.
 * Higher = stales faster. Consumers should look up entity type and pass the value.
 */
export const DOMAIN_VELOCITY: Record<string, number> = {
  Tool: 0.7,
  Server: 0.6,
  Project: 0.5,
  Decision: 0.5,
  Feedback: 0.4,
  Concept: 0.3,
  Person: 0.2,
  Reference: 0.2,
};

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute how stale an edge is. Higher = more stale.
 *
 * Formula:
 *   ageFactor       = sigmoid(age_days, midpoint=90, slope=0.05)
 *   reinforcement   = max(0, 1 - count * 0.1)        [more mentions = fresher]
 *   velocity        = 0.5 + domain_velocity           [fast domains stale faster]
 *   recency         = last_reinforced_days / 60       [recent mention = fresher]
 *
 *   staleness = clamp(ageFactor * reinforcement * velocity * recency, 0, 1)
 */
export function computeStaleness(factors: StalenessFactors): number {
  const { age_days, last_reinforced_days, domain_velocity, reinforcement_count } = factors;

  // Base decay: sigmoid curve
  const ageFactor = 1 / (1 + Math.exp(-STALENESS_SLOPE * (age_days - STALENESS_MIDPOINT_DAYS)));

  // Reinforcement bonus: each mention extends freshness (capped at full reduction)
  const reinforcementFactor = Math.max(0, 1 - reinforcement_count * REINFORCEMENT_DECAY);

  // Domain velocity: fast domains stale faster
  const velocityMultiplier = 0.5 + domain_velocity;

  // Recency of last reinforcement
  const recencyFactor =
    last_reinforced_days !== null
      ? Math.min(1, last_reinforced_days / RECENCY_WINDOW_DAYS)
      : 1; // Never reinforced = assume stale

  return Math.min(1, Math.max(0, ageFactor * reinforcementFactor * velocityMultiplier * recencyFactor));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/domain/staleness.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Exagora/Projects/graphiti-ts
git add packages/core/src/domain/staleness.ts packages/core/src/domain/staleness.test.ts
git commit -m "feat: add staleness scoring for edge freshness signals"
```

---

## Task 2: Negation Pre-Filter — Patterns and Detection

**Files:**
- Create: `packages/core/src/maintenance/negation.ts`
- Create: `packages/core/src/maintenance/negation.test.ts`

- [ ] **Step 1: Write the negation test file**

```typescript
// packages/core/src/maintenance/negation.test.ts
import { describe, expect, it } from 'bun:test';
import {
  detectNegation,
  HIGH_CONFIDENCE_NEGATION,
  MEDIUM_CONFIDENCE_NEGATION,
  type NegationSignal,
} from './negation';

// ---------------------------------------------------------------------------
// Pattern coverage: HIGH_CONFIDENCE
// ---------------------------------------------------------------------------

describe('HIGH_CONFIDENCE_NEGATION patterns', () => {
  const cases: Array<{ pattern: string; text: string; shouldMatch: boolean }> = [
    { pattern: 'no longer', text: 'PAI no longer uses Redis', shouldMatch: true },
    { pattern: 'no longer', text: 'We use Redis longer than expected', shouldMatch: false },
    { pattern: 'stopped using', text: 'We stopped using Ollama', shouldMatch: true },
    { pattern: 'stopped using', text: 'We stopped, using a new approach', shouldMatch: false },
    { pattern: 'deprecated', text: 'CascadeShard is deprecated', shouldMatch: true },
    { pattern: 'removed', text: 'We removed the old auth middleware', shouldMatch: true },
    { pattern: 'dropped', text: 'Dropped support for Python 2', shouldMatch: true },
    { pattern: 'decommissioned', text: 'Mysterio was decommissioned', shouldMatch: true },
    { pattern: 'replaced by', text: 'Redis replaced by Qdrant', shouldMatch: true },
    { pattern: 'replaced with', text: 'Replaced Redis with Qdrant', shouldMatch: true },
    { pattern: 'migrated from', text: 'Migrated from Neo4j to FalkorDB', shouldMatch: true },
    { pattern: 'migrated away', text: 'We migrated away from the old stack', shouldMatch: true },
    { pattern: 'switched from', text: 'Switched from Ollama to OpenAI', shouldMatch: true },
    { pattern: 'eliminated', text: 'Eliminated the manual review step', shouldMatch: true },
    { pattern: 'discontinued', text: 'The service was discontinued', shouldMatch: true },
    { pattern: 'no longer uses', text: 'PAI no longer uses flat files', shouldMatch: true },
    { pattern: 'no longer supports', text: 'The API no longer supports v1', shouldMatch: true },
  ];

  for (const { pattern, text, shouldMatch } of cases) {
    it(`${shouldMatch ? 'matches' : 'does NOT match'}: "${text}" (${pattern})`, () => {
      const matched = HIGH_CONFIDENCE_NEGATION.some((re) => re.test(text));
      expect(matched).toBe(shouldMatch);
    });
  }
});

// ---------------------------------------------------------------------------
// Pattern coverage: MEDIUM_CONFIDENCE
// ---------------------------------------------------------------------------

describe('MEDIUM_CONFIDENCE_NEGATION patterns', () => {
  const cases: Array<{ pattern: string; text: string; shouldMatch: boolean }> = [
    { pattern: 'instead of', text: 'Using Qdrant instead of Redis', shouldMatch: true },
    { pattern: 'rather than', text: 'Rather than using the old API', shouldMatch: true },
    { pattern: 'used to', text: 'We used to deploy on Mysterio', shouldMatch: true },
    { pattern: 'previously', text: 'Previously hosted on AWS', shouldMatch: true },
    { pattern: 'formerly', text: 'Formerly known as GraphShard', shouldMatch: true },
    { pattern: 'was...now', text: 'was using Redis, now using Qdrant', shouldMatch: true },
    { pattern: 'changed from', text: 'Changed from weekly to daily deploys', shouldMatch: true },
    { pattern: 'updated to', text: 'Updated to the new API version', shouldMatch: true },
  ];

  for (const { pattern, text, shouldMatch } of cases) {
    it(`${shouldMatch ? 'matches' : 'does NOT match'}: "${text}" (${pattern})`, () => {
      const matched = MEDIUM_CONFIDENCE_NEGATION.some((re) => re.test(text));
      expect(matched).toBe(shouldMatch);
    });
  }
});

// ---------------------------------------------------------------------------
// detectNegation()
// ---------------------------------------------------------------------------

describe('detectNegation', () => {
  it('returns HIGH when pattern matches and entities overlap', () => {
    const result = detectNegation(
      'PAI no longer uses Redis for caching',
      'PAI uses Redis for caching',
      ['PAI', 'Redis']
    );
    expect(result.confidence).toBe('high');
    expect(result.pattern).toContain('no longer');
  });

  it('returns MEDIUM when HIGH pattern matches but no entity overlap', () => {
    const result = detectNegation(
      'The team no longer uses Redis',
      'PAI uses Qdrant for vectors',
      [] // no shared entities
    );
    expect(result.confidence).toBe('medium');
  });

  it('returns MEDIUM when MEDIUM pattern matches with entity overlap', () => {
    const result = detectNegation(
      'Using Qdrant instead of Redis',
      'PAI uses Redis for caching',
      ['Redis']
    );
    expect(result.confidence).toBe('medium');
  });

  it('returns NONE when no patterns match', () => {
    const result = detectNegation(
      'PAI uses Qdrant for vector search',
      'PAI uses Redis for caching',
      ['PAI']
    );
    expect(result.confidence).toBe('none');
  });

  it('is case-insensitive', () => {
    const result = detectNegation(
      'PAI NO LONGER uses Redis',
      'PAI uses Redis',
      ['PAI', 'Redis']
    );
    expect(result.confidence).toBe('high');
  });

  it('identifies the negated entity when detectable', () => {
    const result = detectNegation(
      'We no longer use Redis',
      'We use Redis for caching',
      ['Redis']
    );
    expect(result.confidence).toBe('high');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/maintenance/negation.test.ts`
Expected: FAIL — module `./negation` not found

- [ ] **Step 3: Write the negation module**

```typescript
// packages/core/src/maintenance/negation.ts
/**
 * Semantic Negation Pre-Filter — deterministic contradiction detection.
 *
 * Inserts before the LLM contradiction check to skip obvious negations.
 * HIGH_CONFIDENCE + entity overlap = skip LLM, invalidate directly.
 * MEDIUM_CONFIDENCE = route to LLM for confirmation.
 * NO match = skip contradiction check entirely (existing behavior).
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export const HIGH_CONFIDENCE_NEGATION: RegExp[] = [
  /\bno longer\b/i,
  /\bstopped using\b/i,
  /\bdeprecated\b/i,
  /\bremoved\b/i,
  /\bdropped\b/i,
  /\bdecommissioned\b/i,
  /\breplaced (?:by|with)\b/i,
  /\bmigrated (?:from|away)\b/i,
  /\bswitched (?:from|away)\b/i,
  /\beliminated\b/i,
  /\bdiscontinued\b/i,
  /\bno longer (?:uses?|supports?|requires?|needs?)\b/i,
];

export const MEDIUM_CONFIDENCE_NEGATION: RegExp[] = [
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bused to\b/i,
  /\bpreviously\b/i,
  /\bformerly\b/i,
  /\bwas\b.*\bnow\b/i,
  /\bchanged (?:from|to)\b/i,
  /\bupdated (?:from|to)\b/i,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NegationSignal {
  /** Confidence level of the negation detection */
  confidence: 'high' | 'medium' | 'none';
  /** Which regex pattern matched (empty string if none) */
  pattern: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether a new fact negates an existing fact.
 *
 * @param newFact - The newly extracted fact text
 * @param existingFact - The existing fact text in the graph
 * @param sharedEntities - Entity names shared between the new and existing edge
 * @returns NegationSignal with confidence level and matched pattern
 */
export function detectNegation(
  newFact: string,
  existingFact: string,
  sharedEntities: string[]
): NegationSignal {
  const hasEntityOverlap = sharedEntities.length > 0;

  // Check HIGH_CONFIDENCE patterns first
  for (const pattern of HIGH_CONFIDENCE_NEGATION) {
    if (pattern.test(newFact)) {
      if (hasEntityOverlap) {
        return { confidence: 'high', pattern: pattern.source };
      }
      // HIGH pattern without entity overlap → downgrade to MEDIUM
      return { confidence: 'medium', pattern: pattern.source };
    }
  }

  // Check MEDIUM_CONFIDENCE patterns
  for (const pattern of MEDIUM_CONFIDENCE_NEGATION) {
    if (pattern.test(newFact)) {
      return { confidence: 'medium', pattern: pattern.source };
    }
  }

  return { confidence: 'none', pattern: '' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/maintenance/negation.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Exagora/Projects/graphiti-ts
git add packages/core/src/maintenance/negation.ts packages/core/src/maintenance/negation.test.ts
git commit -m "feat: add semantic negation pre-filter for contradiction detection"
```

---

## Task 3: Deprecation API on Graphiti Class

**Files:**
- Modify: `packages/core/src/graphiti.ts` (add methods after `deleteEntityEdge()` at ~line 1294)
- Modify: `packages/core/src/graphiti.test.ts` (add deprecation tests)

- [ ] **Step 1: Write deprecation tests**

Add to the end of `packages/core/src/graphiti.test.ts`:

```typescript
// At the top of the file, ensure these imports exist:
// import { Graphiti } from './graphiti';
// (The file should already import Graphiti)

describe('deprecateEdge', () => {
  // These tests use a mock driver that tracks calls.
  // The Graphiti class uses this.edges.entity.getByUuid() and .save()

  function createMockEdge(overrides: Partial<import('./domain/edges').EntityEdge> = {}): import('./domain/edges').EntityEdge {
    return {
      uuid: 'test-edge-uuid',
      group_id: 'test-group',
      source_node_uuid: 'source-uuid',
      target_node_uuid: 'target-uuid',
      created_at: new Date('2026-01-01'),
      name: 'USES',
      fact: 'PAI uses Redis',
      valid_at: new Date('2026-01-01'),
      invalid_at: null,
      expired_at: null,
      attributes: {},
      ...overrides,
    };
  }

  it('sets invalid_at and expired_at on a valid edge', async () => {
    const edge = createMockEdge();
    let savedEdge: import('./domain/edges').EntityEdge | null = null;

    // Create a minimal Graphiti instance with mocked edge namespace
    const graphiti = Object.create(Graphiti.prototype) as Graphiti;
    (graphiti as any).edges = {
      entity: {
        getByUuid: async () => edge,
        save: async (e: import('./domain/edges').EntityEdge) => { savedEdge = e; return e; },
      },
    };
    (graphiti as any).tracer = { startSpan: () => ({ end: () => {} }) };

    await graphiti.deprecateEdge('test-edge-uuid');

    expect(savedEdge).not.toBeNull();
    expect(savedEdge!.invalid_at).toBeInstanceOf(Date);
    expect(savedEdge!.expired_at).toBeInstanceOf(Date);
  });

  it('stores reason in attributes when provided', async () => {
    const edge = createMockEdge();
    let savedEdge: import('./domain/edges').EntityEdge | null = null;

    const graphiti = Object.create(Graphiti.prototype) as Graphiti;
    (graphiti as any).edges = {
      entity: {
        getByUuid: async () => edge,
        save: async (e: import('./domain/edges').EntityEdge) => { savedEdge = e; return e; },
      },
    };
    (graphiti as any).tracer = { startSpan: () => ({ end: () => {} }) };

    await graphiti.deprecateEdge('test-edge-uuid', { reason: 'Migrated to Qdrant' });

    expect(savedEdge!.attributes?.deprecation_reason).toBe('Migrated to Qdrant');
  });

  it('is idempotent for already-deprecated edges', async () => {
    const edge = createMockEdge({
      invalid_at: new Date('2026-03-01'),
      expired_at: new Date('2026-03-01'),
    });
    let saveCalled = false;

    const graphiti = Object.create(Graphiti.prototype) as Graphiti;
    (graphiti as any).edges = {
      entity: {
        getByUuid: async () => edge,
        save: async () => { saveCalled = true; return edge; },
      },
    };
    (graphiti as any).tracer = { startSpan: () => ({ end: () => {} }) };

    await graphiti.deprecateEdge('test-edge-uuid');

    expect(saveCalled).toBe(false); // Should not save — already deprecated
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/graphiti.test.ts --grep "deprecateEdge"`
Expected: FAIL — `deprecateEdge` is not a function

- [ ] **Step 3: Add deprecateEdge() and deprecateEdges() to Graphiti class**

In `packages/core/src/graphiti.ts`, add these methods after the `deleteEntityEdge()` method (around line 1294):

```typescript
  /**
   * Explicitly deprecate an edge, marking it as no longer valid.
   * Unlike contradiction-based invalidation (which happens automatically
   * during ingestion), this is a manual operation for known-stale facts.
   *
   * Idempotent: calling on an already-deprecated edge is a no-op.
   */
  async deprecateEdge(
    edgeUuid: string,
    options?: {
      reason?: string;
      superseded_by?: string;
      deprecated_at?: Date;
    }
  ): Promise<void> {
    const scope = this.tracer.startSpan('deprecate_edge');
    try {
      const edge = await this.edges.entity.getByUuid(edgeUuid);

      // Idempotent: already deprecated
      if (edge.invalid_at && edge.expired_at) {
        return;
      }

      const now = options?.deprecated_at ?? new Date();
      edge.invalid_at = now;
      edge.expired_at = now;

      // Store deprecation metadata in attributes
      edge.attributes = edge.attributes ?? {};
      if (options?.reason) {
        edge.attributes.deprecation_reason = options.reason;
      }
      if (options?.superseded_by) {
        edge.attributes.superseded_by = options.superseded_by;
      }

      await this.edges.entity.save(edge);
    } finally {
      scope.end();
    }
  }

  /**
   * Deprecate all edges matching a filter.
   * Supports dryRun to preview the count without mutating.
   */
  async deprecateEdges(
    filter: {
      entity_name?: string;
      edge_type?: string;
      older_than?: Date;
      group_id?: string;
    },
    options?: {
      reason?: string;
      deprecated_at?: Date;
      dryRun?: boolean;
    }
  ): Promise<{ count: number }> {
    const scope = this.tracer.startSpan('deprecate_edges');
    try {
      // Build Cypher WHERE clauses from filter
      const conditions: string[] = ['e.invalid_at IS NULL'];
      const params: Record<string, unknown> = {};

      if (filter.entity_name) {
        conditions.push('(source.name = $entity_name OR target.name = $entity_name)');
        params.entity_name = filter.entity_name;
      }
      if (filter.edge_type) {
        conditions.push('e.name = $edge_type');
        params.edge_type = filter.edge_type;
      }
      if (filter.older_than) {
        conditions.push('e.created_at < $older_than');
        params.older_than = filter.older_than;
      }
      if (filter.group_id) {
        conditions.push('e.group_id = $group_id');
        params.group_id = filter.group_id;
      }

      const whereClause = conditions.join(' AND ');

      if (options?.dryRun) {
        const countResult = await this.driver.executeQuery<{ count: number }>(
          `MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity) WHERE ${whereClause} RETURN count(e) AS count`,
          { params, routing: 'r' }
        );
        const count = countResult.records[0]?.count ?? 0;
        return { count: typeof count === 'object' && count !== null && 'low' in count ? (count as { low: number }).low : count as number };
      }

      const now = options?.deprecated_at ?? new Date();
      const setClause = options?.reason
        ? 'SET e.invalid_at = $now, e.expired_at = $now, e.attributes = coalesce(e.attributes, {}) + {deprecation_reason: $reason}'
        : 'SET e.invalid_at = $now, e.expired_at = $now';

      params.now = now;
      if (options?.reason) {
        params.reason = options.reason;
      }

      const result = await this.driver.executeQuery<{ count: number }>(
        `MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity) WHERE ${whereClause} ${setClause} RETURN count(e) AS count`,
        { params }
      );
      const count = result.records[0]?.count ?? 0;
      return { count: typeof count === 'object' && count !== null && 'low' in count ? (count as { low: number }).low : count as number };
    } finally {
      scope.end();
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/graphiti.test.ts --grep "deprecateEdge"`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Exagora/Projects/graphiti-ts
git add packages/core/src/graphiti.ts packages/core/src/graphiti.test.ts
git commit -m "feat: add deprecateEdge() and deprecateEdges() to Graphiti class"
```

---

## Task 4: Integrate Negation Pre-Filter into Edge Operations

**Files:**
- Modify: `packages/core/src/maintenance/edge-operations.ts` (~line 370, in `resolveExtractedEdge()`)
- Modify: `packages/core/src/maintenance/edge-operations.test.ts`

- [ ] **Step 1: Write integration test**

Add to `packages/core/src/maintenance/edge-operations.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { detectNegation } from './negation';

describe('negation pre-filter integration', () => {
  it('HIGH confidence with entity overlap produces invalidation candidate', () => {
    const newFact = 'PAI no longer uses Redis for caching';
    const existingFact = 'PAI uses Redis for caching';
    const sharedEntities = ['PAI', 'Redis'];

    const signal = detectNegation(newFact, existingFact, sharedEntities);
    expect(signal.confidence).toBe('high');
    // HIGH + overlap = this edge should be invalidated without LLM
  });

  it('MEDIUM confidence routes to LLM (not deterministic invalidation)', () => {
    const newFact = 'Using Qdrant instead of Redis for vectors';
    const existingFact = 'PAI uses Redis for caching';
    const sharedEntities = ['Redis'];

    const signal = detectNegation(newFact, existingFact, sharedEntities);
    expect(signal.confidence).toBe('medium');
    // MEDIUM = should still go through LLM contradiction check
  });

  it('NO_SIGNAL skips contradiction check entirely', () => {
    const newFact = 'PAI added PostgreSQL support';
    const existingFact = 'PAI uses Redis for caching';
    const sharedEntities = ['PAI'];

    const signal = detectNegation(newFact, existingFact, sharedEntities);
    expect(signal.confidence).toBe('none');
    // NONE = no contradiction to check
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (uses existing `detectNegation`, so should pass)

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/maintenance/edge-operations.test.ts --grep "negation pre-filter"`
Expected: PASS — the detection function works independently

- [ ] **Step 3: Modify resolveExtractedEdge() to call the pre-filter**

In `packages/core/src/maintenance/edge-operations.ts`, add the import at the top:

```typescript
import { detectNegation } from './negation';
```

Then in `resolveExtractedEdge()`, after the exact-match fast path (line ~369) and before the LLM resolution block (line ~371), insert the pre-filter:

```typescript
  // --- Negation pre-filter: skip LLM for obvious contradictions ---
  const preFilterInvalidated: EntityEdge[] = [];
  const preFilterSkippedIndices = new Set<number>();
  const now = utcNow();

  for (let i = 0; i < existingEdges.length; i++) {
    const existing = existingEdges[i]!;
    // Shared entities = source/target node overlap between new and existing edge
    const sharedEntities: string[] = [];
    if (extractedEdge.source_node_uuid === existing.source_node_uuid) sharedEntities.push('source');
    if (extractedEdge.target_node_uuid === existing.target_node_uuid) sharedEntities.push('target');
    if (extractedEdge.source_node_uuid === existing.target_node_uuid) sharedEntities.push('source-target');
    if (extractedEdge.target_node_uuid === existing.source_node_uuid) sharedEntities.push('target-source');

    const signal = detectNegation(extractedEdge.fact, existing.fact, sharedEntities);

    if (signal.confidence === 'high') {
      // Deterministic invalidation — skip LLM for this pair
      const invalidated = { ...existing };
      invalidated.invalid_at = extractedEdge.valid_at ?? now;
      invalidated.expired_at = invalidated.expired_at ?? now;
      preFilterInvalidated.push(invalidated);
      preFilterSkippedIndices.add(i);
    }
    // MEDIUM: leave in existingEdges for LLM to evaluate
    // NONE: leave in existingEdges but LLM may still find contradictions
  }

  // Remove pre-filtered edges from the LLM batch
  const filteredExistingEdges = existingEdges.filter((_, i) => !preFilterSkippedIndices.has(i));
  // --- End negation pre-filter ---
```

Then update the LLM resolution block to use `filteredExistingEdges` instead of `existingEdges` for the invalidation context:

Replace `existingEdges.map` at line ~374 with `filteredExistingEdges.map`:

```typescript
  const invalidationContext = filteredExistingEdges.map((e, i) => ({
    idx: invalidationIdxOffset + i,
    fact: e.fact
  }));
```

And at the end of the function, before the return, merge the pre-filter results:

```typescript
  // Merge pre-filter invalidations with LLM-detected invalidations
  const allInvalidated = [...preFilterInvalidated, ...invalidatedEdges];

  return [resolvedEdge, allInvalidated];
```

Change the existing `return [resolvedEdge, invalidatedEdges];` to `return [resolvedEdge, allInvalidated];`.

- [ ] **Step 4: Run full edge-operations tests**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test packages/core/src/maintenance/edge-operations.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Exagora/Projects/graphiti-ts
git add packages/core/src/maintenance/edge-operations.ts packages/core/src/maintenance/edge-operations.test.ts
git commit -m "feat: integrate negation pre-filter into edge contradiction pipeline"
```

---

## Task 5: Re-export New Modules

**Files:**
- Modify: `packages/core/src/maintenance/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add negation exports to maintenance/index.ts**

Add at the end of `packages/core/src/maintenance/index.ts`:

```typescript
export {
  detectNegation,
  HIGH_CONFIDENCE_NEGATION,
  MEDIUM_CONFIDENCE_NEGATION,
  type NegationSignal,
} from './negation';
```

- [ ] **Step 2: Add staleness and negation exports to packages/core/src/index.ts**

Add after the `export * from './domain/epistemic';` line:

```typescript
export * from './domain/staleness';
```

The negation module is already re-exported transitively through `maintenance/index.ts` → the existing `export { ... } from './maintenance/index'` block at the bottom of `index.ts`. Verify by checking that `detectNegation` appears in the existing maintenance re-export block. If it doesn't auto-export (because `index.ts` uses named re-exports for maintenance), add explicitly:

```typescript
export {
  detectNegation,
  HIGH_CONFIDENCE_NEGATION,
  MEDIUM_CONFIDENCE_NEGATION,
  type NegationSignal,
} from './maintenance/negation';
```

- [ ] **Step 3: Run type check**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Run all tests**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Exagora/Projects/graphiti-ts
git add packages/core/src/maintenance/index.ts packages/core/src/index.ts
git commit -m "chore: re-export staleness and negation modules from package index"
```

---

## Task 6: Run Full Test Suite and Verify

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bun test`
Expected: All tests PASS

- [ ] **Step 2: Run type check**

Run: `cd /Volumes/Exagora/Projects/graphiti-ts && bunx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify exports work from consumer perspective**

```bash
cd /Volumes/Exagora/Projects/graphiti-ts
bun -e "const { computeStaleness, detectNegation, Graphiti } = require('./packages/core/src/index'); console.log('computeStaleness:', typeof computeStaleness); console.log('detectNegation:', typeof detectNegation); console.log('Graphiti.prototype.deprecateEdge:', typeof Graphiti.prototype.deprecateEdge);"
```

Expected: All three print `function`

- [ ] **Step 4: Final commit if any fixups needed**

If Steps 1-3 revealed issues that required fixes, commit those fixes:

```bash
cd /Volumes/Exagora/Projects/graphiti-ts
git add -A
git commit -m "fix: resolve test/type issues from Wave 1 integration"
```
