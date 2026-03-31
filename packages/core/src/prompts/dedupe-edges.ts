/**
 * Edge deduplication prompts — port of Python's graphiti_core/prompts/dedupe_edges.py.
 */

import type { Message } from './types';

export function resolveEdge(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that de-duplicates facts from fact lists and determines ' +
        'which existing facts are contradicted by the new fact.'
    },
    {
      role: 'user',
      content: `EXISTING FACTS (indexed starting at 0):
${context.existing_facts ?? '[]'}

FACT INVALIDATION CANDIDATES (indexed continuously after existing facts):
${context.invalidation_candidates ?? '[]'}

NEW FACT:
${context.new_fact ?? ''}

TASK:
1. DUPLICATE DETECTION: Identify which EXISTING FACTS contain the same factual information as the NEW FACT.
   - Facts with key differences are NOT duplicates
   - Only include indices from the EXISTING FACTS range
   - Return empty list if no duplicates

2. CONTRADICTION DETECTION: Determine which facts from EITHER list the NEW FACT contradicts.
   - A fact can be both a duplicate and contradicted
   - Return all contradicted indices from EITHER list
   - Return empty list if no contradictions

IMPORTANT:
- duplicate_facts indices ONLY from EXISTING FACTS range
- contradicted_facts indices from EITHER list
- Indexing is continuous across both lists

Respond with JSON: {"duplicate_facts": [...], "contradicted_facts": [...]}`
    }
  ];
}
