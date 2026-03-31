/**
 * Evaluation prompts — port of Python's graphiti_core/prompts/eval.py.
 */

import type { Message } from './types';

// --- Response Models ---

export interface QueryExpansion {
  query: string;
}

export interface QAResponse {
  ANSWER: string;
}

export interface EvalResponse {
  is_correct: boolean;
  reasoning: string;
}

export interface EvalAddEpisodeResults {
  candidate_is_worse: boolean;
  reasoning: string;
}

// --- Prompt Functions ---

export function queryExpansion(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that rephrases questions for database retrieval. ' +
        'Rephrase the question to be more suitable for searching a knowledge graph.'
    },
    {
      role: 'user',
      content: `Rephrase the following question for better database retrieval:

QUESTION:
${context.query ?? ''}

Respond with JSON: {"query": "..."}`
    }
  ];
}

export function qaPrompt(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are Alice, a helpful assistant that answers questions using the provided entity summaries and facts. ' +
        'Only use the information provided. If the answer is not in the provided context, say "I don\'t know."'
    },
    {
      role: 'user',
      content: `ENTITY SUMMARIES:
${context.entity_summaries ?? 'None'}

FACTS:
${context.facts ?? 'None'}

QUESTION:
${context.question ?? ''}

Respond with JSON: {"ANSWER": "..."}`
    }
  ];
}

export function evalPrompt(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are an impartial judge evaluating whether a response correctly answers a question. ' +
        'Compare the response to the gold standard answer.'
    },
    {
      role: 'user',
      content: `QUESTION:
${context.question ?? ''}

GOLD STANDARD ANSWER:
${context.gold_answer ?? ''}

RESPONSE TO EVALUATE:
${context.response ?? ''}

Determine if the response correctly answers the question compared to the gold standard.
Consider semantic equivalence — the response doesn't need to be word-for-word identical.

Respond with JSON: {"is_correct": true/false, "reasoning": "..."}`
    }
  ];
}

export function evalAddEpisodeResults(context: Record<string, unknown>): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are an impartial judge comparing graph extraction quality. ' +
        'You will compare a baseline extraction against a candidate extraction and determine ' +
        'if the candidate is worse than the baseline.'
    },
    {
      role: 'user',
      content: `EPISODE CONTENT:
${context.episode_content ?? ''}

BASELINE EXTRACTION:
${context.baseline ?? '{}'}

CANDIDATE EXTRACTION:
${context.candidate ?? '{}'}

Compare the two extractions. Consider:
- Completeness of entity extraction
- Accuracy of relationships
- Quality of fact descriptions
- Temporal information accuracy

Respond with JSON: {"candidate_is_worse": true/false, "reasoning": "..."}`
    }
  ];
}
