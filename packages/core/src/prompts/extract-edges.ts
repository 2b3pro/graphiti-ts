/**
 * Edge extraction prompts — port of Python's graphiti_core/prompts/extract_edges.py.
 */

import type { Message } from './types';

export function extractEdges(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are an expert fact extractor that extracts fact triples from text. ' +
        '1. Extracted fact triples should also be extracted with relevant date information. ' +
        '2. Treat the CURRENT TIME as the time the CURRENT MESSAGE was sent. ' +
        'All temporal information should be extracted relative to this time.'
    },
    {
      role: 'user',
      content: `PREVIOUS MESSAGES:
${context.previous_messages ?? 'None'}

CURRENT MESSAGE:
${context.current_message ?? ''}

ENTITIES:
${context.entities ?? '[]'}

REFERENCE TIME: ${context.reference_time ?? new Date().toISOString()}
${context.fact_types ? `\nFACT TYPES:\n${context.fact_types}` : ''}

TASK:
Extract factual relationships between the ENTITIES from the CURRENT MESSAGE.

EXTRACTION RULES:
- Source and target entity names MUST exactly match names from the ENTITIES list (CRITICAL)
- Source and target must be distinct entities
- No duplicate edges (same source, target, and fact)
- Paraphrase facts into clear, standalone statements
- Use REFERENCE_TIME to resolve relative temporal expressions ("yesterday", "last week")
- Do not hallucinate facts not present in the text

RELATION TYPE RULES:
${context.fact_types ? '- Use a matching FACT TYPE if one applies' : '- Derive a descriptive type'} in SCREAMING_SNAKE_CASE format

DATETIME RULES:
- All dates in ISO 8601 format with Z suffix (UTC)
- Ongoing facts: set valid_at to REFERENCE_TIME, invalid_at to null
- Changed facts: set invalid_at to when the change occurred
- No explicit temporal info: set both to null
- Date only: assume 00:00:00Z
- Year only: use January 1 00:00:00Z

Respond with JSON: {"edges": [{"source_entity_name": "...", "target_entity_name": "...", "relation_type": "...", "fact": "...", "valid_at": "..." or null, "invalid_at": "..." or null}, ...]}`
    }
  ];
}

export function extractEdgeAttributes(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that extracts fact properties from the provided text.'
    },
    {
      role: 'user',
      content: `FACT:
${context.fact ?? ''}

REFERENCE TIME: ${context.reference_time ?? new Date().toISOString()}

EXISTING ATTRIBUTES:
${context.existing_attributes ?? '{}'}

TASK:
Extract or update attributes for this fact based on the provided information.

GUIDELINES:
- Only extract values explicitly stated in the fact
- Do not hallucinate values
- Use REFERENCE_TIME to resolve relative temporal expressions
- Preserve existing attribute values unless new information supersedes them

Respond with JSON containing the updated attributes object.`
    }
  ];
}
