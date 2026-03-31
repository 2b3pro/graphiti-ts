/**
 * Node extraction prompts — port of Python's graphiti_core/prompts/extract_nodes.py.
 */

import type { Message } from './types';
import { SUMMARY_INSTRUCTIONS } from './snippets';

export function extractMessage(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are an AI assistant that extracts entity nodes from conversational messages. ' +
        'Your primary task is to extract and classify the speaker and other significant entities ' +
        'mentioned in the conversation.'
    },
    {
      role: 'user',
      content: `ENTITY TYPES:
${context.entity_types ?? 'No entity types provided.'}

PREVIOUS MESSAGES:
${context.previous_messages ?? 'None'}

CURRENT MESSAGE:
${context.current_message ?? ''}

TASK:
Extract all significant entities from the CURRENT MESSAGE including:
1. The speaker (the person sending the message)
2. People, organizations, places, concepts, and other named entities mentioned
3. Classify each entity with the most appropriate entity_type_id from ENTITY TYPES

GUIDELINES:
- Do NOT extract relationships, actions, or temporal information as entities
- Use the full, most specific name for each entity
- Each entity_type_id must reference a valid type from the ENTITY TYPES list
- If no matching type exists, use 0

Respond with JSON: {"extracted_entities": [{"name": "...", "entity_type_id": ...}, ...]}`
    }
  ];
}

export function extractJson(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are an AI assistant that extracts entity nodes from JSON. ' +
        'Your primary task is to extract and classify relevant entities from JSON files.'
    },
    {
      role: 'user',
      content: `ENTITY TYPES:
${context.entity_types ?? 'No entity types provided.'}

SOURCE DESCRIPTION:
${context.source_description ?? ''}

JSON CONTENT:
${context.content ?? ''}

TASK:
Extract all significant entities that the JSON represents or mentions.

GUIDELINES:
- Extract the entities the JSON represents (e.g., a user profile JSON → extract the user)
- Extract all mentioned entities (people, organizations, places, concepts)
- Do NOT extract date properties as entities
- Classify each entity with the most appropriate entity_type_id from ENTITY TYPES

Respond with JSON: {"extracted_entities": [{"name": "...", "entity_type_id": ...}, ...]}`
    }
  ];
}

export function extractText(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are an AI assistant that extracts entity nodes from text. ' +
        'Your primary task is to extract and classify significant entities mentioned in the provided text.'
    },
    {
      role: 'user',
      content: `ENTITY TYPES:
${context.entity_types ?? 'No entity types provided.'}

TEXT:
${context.content ?? ''}

TASK:
Extract all significant entities from the text.

GUIDELINES:
- Extract people, organizations, places, concepts, and other named entities
- Avoid extracting relationships, actions, or temporal information as entities
- Be explicit with full names (e.g., "John Smith" not "John")
- Classify each entity with the most appropriate entity_type_id from ENTITY TYPES

Respond with JSON: {"extracted_entities": [{"name": "...", "entity_type_id": ...}, ...]}`
    }
  ];
}

export function classifyNodes(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are an AI assistant that classifies entity nodes given the context from which they were extracted.'
    },
    {
      role: 'user',
      content: `PREVIOUS MESSAGES:
${context.previous_messages ?? 'None'}

CURRENT MESSAGE:
${context.current_message ?? ''}

EXTRACTED ENTITIES:
${context.entities ?? '[]'}

ENTITY TYPES:
${context.entity_types ?? 'No entity types provided.'}

TASK:
Classify each extracted entity with the most appropriate entity_type_id.

GUIDELINES:
- Each entity must have exactly one type
- Only use types from the ENTITY TYPES list
- Set entity_type_id to 0 if no matching type exists

Respond with JSON: {"extracted_entities": [{"name": "...", "entity_type_id": ...}, ...]}`
    }
  ];
}

export function extractAttributes(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that extracts entity properties from the provided text.'
    },
    {
      role: 'user',
      content: `MESSAGES:
${context.messages ?? ''}

ENTITY:
${context.entity ?? ''}

TASK:
Update the entity's attributes based on information from the MESSAGES.

GUIDELINES:
- Only extract values explicitly stated in the messages
- Do not hallucinate or infer values not in the text
- Preserve existing attribute values unless new information supersedes them

Respond with JSON containing the updated attributes object.`
    }
  ];
}

export function extractSummary(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that extracts entity summaries from the provided text.'
    },
    {
      role: 'user',
      content: `MESSAGES:
${context.messages ?? ''}

ENTITY:
${context.entity ?? ''}

TASK:
Generate an updated summary for this entity combining all relevant information from the messages.

${SUMMARY_INSTRUCTIONS}

Respond with JSON: {"summary": "..."}`
    }
  ];
}

export function extractSummariesBatch(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that generates concise entity summaries from provided context.'
    },
    {
      role: 'user',
      content: `MESSAGES:
${context.messages ?? ''}

ENTITIES:
${context.entities ?? '[]'}

TASK:
Generate updated summaries for each entity that needs one, using only information from the messages.

${SUMMARY_INSTRUCTIONS}

Only return summaries with meaningful information.

Respond with JSON: {"summaries": [{"name": "...", "summary": "..."}, ...]}`
    }
  ];
}
