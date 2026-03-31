/**
 * Node deduplication prompts — port of Python's graphiti_core/prompts/dedupe_nodes.py.
 */

import type { Message } from './types';

export function dedupeNode(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that determines whether or not a NEW ENTITY is a ' +
        'duplicate of any EXISTING ENTITIES.'
    },
    {
      role: 'user',
      content: `PREVIOUS MESSAGES:
${context.previous_messages ?? 'None'}

CURRENT MESSAGE:
${context.current_message ?? ''}

NEW ENTITY:
${context.new_entity ?? ''}

ENTITY TYPE DESCRIPTION:
${context.entity_type_description ?? 'No type description.'}

EXISTING ENTITIES:
${context.existing_entities ?? '[]'}

TASK:
Determine if the NEW ENTITY is a duplicate of any EXISTING ENTITY.

GUIDELINES:
- Duplicates refer to the same real-world object, person, or concept
- Semantic equivalence counts (e.g., "NYC" and "New York City")
- Do NOT mark as duplicates if they are related but distinct (e.g., a person and their company)
- Do NOT mark as duplicates if they are similar but separate instances

Respond with JSON: {"entity_resolutions": [{"id": 0, "name": "...", "duplicate_name": "..." or ""}]}`
    }
  ];
}

export function dedupeNodes(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that determines whether or not ENTITIES extracted from ' +
        'a conversation are duplicates of existing entities.'
    },
    {
      role: 'user',
      content: `PREVIOUS MESSAGES:
${context.previous_messages ?? 'None'}

CURRENT MESSAGE:
${context.current_message ?? ''}

ENTITIES (extracted, indexed 0 to N-1):
${context.entities ?? '[]'}

EXISTING ENTITIES:
${context.existing_entities ?? '[]'}

TASK:
For each ENTITY, determine if it is a duplicate of any EXISTING ENTITY.

GUIDELINES:
- Duplicates refer to the same real-world object, person, or concept
- Semantic equivalence counts (e.g., "NYC" and "New York City")
- Do NOT mark as duplicates if related but distinct or similar but separate instances
- You MUST include EXACTLY N resolutions (one per extracted entity), with IDs 0 through N-1

Respond with JSON: {"entity_resolutions": [{"id": 0, "name": "...", "duplicate_name": "..." or ""}, ...]}`
    }
  ];
}

export function dedupeNodeList(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that de-duplicates nodes from node lists.'
    },
    {
      role: 'user',
      content: `NODES:
${context.nodes ?? '[]'}

TASK:
Group duplicate nodes together by uuid and synthesize their summaries.

GUIDELINES:
- Each uuid must appear EXACTLY once in the output
- Non-duplicate nodes appear in a list containing only their own uuid
- For duplicates, merge their information into a synthesized summary

Respond with JSON: {"nodes": [{"uuids": ["..."], "summary": "..."}, ...]}`
    }
  ];
}
