/**
 * Node summarization prompts — port of Python's graphiti_core/prompts/summarize_nodes.py.
 */

import type { Message } from './types';
import { SUMMARY_INSTRUCTIONS } from './snippets';

export function summarizePair(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that combines summaries.'
    },
    {
      role: 'user',
      content: `Synthesize the following two summaries into a single succinct summary.

IMPORTANT: Keep it concise. MUST BE LESS THAN 250 CHARACTERS.

Summaries:
${JSON.stringify(context.summaries ?? [])}

Respond with JSON: {"summary": "..."}`
    }
  ];
}

/**
 * Generate a summary and attributes for an entity from conversation context.
 * This is the missing summarize_context prompt from Python.
 */
export function summarizeContext(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that generates a summary and attributes from provided text.'
    },
    {
      role: 'user',
      content: `MESSAGES:
${context.messages ?? ''}

ENTITY:
${context.entity ?? ''}

ENTITY CONTEXT:
${context.entity_context ?? ''}

ATTRIBUTES:
${context.attributes ?? '{}'}

TASK:
Create a summary of the entity using only information from the messages.
Extract values for entity properties from descriptions.
If a property value is not found, set to null.

${SUMMARY_INSTRUCTIONS}

Respond with JSON containing both "summary" and updated attributes.`
    }
  ];
}

export function summaryDescription(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that describes provided contents in a single sentence.'
    },
    {
      role: 'user',
      content: `Create a short one-sentence description of the following summary, explaining what information is summarized.

Summaries must be under 250 characters.

Summary:
${JSON.stringify(context.summary ?? '')}

Respond with JSON: {"description": "..."}`
    }
  ];
}
