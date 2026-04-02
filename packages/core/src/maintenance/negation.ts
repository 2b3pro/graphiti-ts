/**
 * Semantic negation pre-filter for edge contradiction detection.
 *
 * Scans new fact text for linguistic markers that strongly or moderately
 * suggest a prior fact is being negated. When a high-confidence signal is
 * found alongside shared entities, the LLM contradiction call can be skipped
 * entirely and the old edge invalidated directly.
 *
 * Two confidence tiers:
 *   - HIGH  — verb phrases that almost always negate a prior state
 *             ("no longer uses", "deprecated", "replaced by", …)
 *   - MEDIUM — hedged or ambiguous markers that suggest past context
 *             ("previously", "used to", "instead of", …)
 */

// ─── Pattern arrays ───────────────────────────────────────────────────────────

/**
 * Patterns that indicate a near-certain negation of a prior fact.
 * When matched alongside shared entities, the LLM call may be skipped.
 */
export const HIGH_CONFIDENCE_NEGATION: RegExp[] = [
  /\bno longer\b/i,
  /\bstopped using\b/i,
  /\bdeprecated\b/i,
  /\bremoved\b/i,
  /\bdropped\b/i,
  /\bdecommissioned\b/i,
  /\breplaced\b(?:\s+\w+)?\s+(?:by|with)\b/i,
  /\bmigrated (?:from|away)\b/i,
  /\bswitched (?:from|away)\b/i,
  /\beliminated\b/i,
  /\bdiscontinued\b/i,
  /\bno longer (?:uses?|supports?|requires?|needs?)\b/i,
];

/**
 * Patterns that suggest a prior fact may have been superseded but are not
 * definitive enough to skip the LLM contradiction check.
 */
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

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of scanning a new fact for negation markers. */
export interface NegationSignal {
  /** Detected confidence level. 'none' means no negation marker was found. */
  confidence: 'high' | 'medium' | 'none';
  /**
   * The `source` property of the matched RegExp, or an empty string when
   * confidence is 'none'. Useful for logging and downstream decisions.
   */
  pattern: string;
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Scan `newFact` for negation markers and return a confidence signal.
 *
 * Decision logic:
 * 1. If a HIGH_CONFIDENCE pattern matches AND `sharedEntities` is non-empty
 *    → `{ confidence: 'high', pattern }`
 * 2. If a HIGH_CONFIDENCE pattern matches but no shared entities
 *    → downgrade to `{ confidence: 'medium', pattern }`
 * 3. If a MEDIUM_CONFIDENCE pattern matches (entity overlap irrelevant)
 *    → `{ confidence: 'medium', pattern }`
 * 4. No match → `{ confidence: 'none', pattern: '' }`
 *
 * @param newFact       The incoming fact text being evaluated.
 * @param existingFact  The prior fact text (reserved for future semantic use).
 * @param sharedEntities Named entities that appear in both facts.
 */
export function detectNegation(
  newFact: string,
  existingFact: string,
  sharedEntities: string[],
): NegationSignal {
  // Step 1 & 2 — HIGH confidence patterns
  for (const pattern of HIGH_CONFIDENCE_NEGATION) {
    if (pattern.test(newFact)) {
      if (sharedEntities.length > 0) {
        return { confidence: 'high', pattern: pattern.source };
      }
      return { confidence: 'medium', pattern: pattern.source };
    }
  }

  // Step 3 — MEDIUM confidence patterns
  for (const pattern of MEDIUM_CONFIDENCE_NEGATION) {
    if (pattern.test(newFact)) {
      return { confidence: 'medium', pattern: pattern.source };
    }
  }

  // Step 4 — No match
  return { confidence: 'none', pattern: '' };
}
