import type { Message } from '../prompts/types';

// ---------------------------------------------------------------------------
// Single-item prompts (used by legacy code and fallback paths)
// ---------------------------------------------------------------------------

export function summarizePairPrompt(summaries: [string, string]): Message[] {
  const nodeSummaries = summaries.map((s) => ({ summary: s }));
  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that combines summaries.'
    },
    {
      role: 'user',
      content: `Synthesize the information from the following two summaries into a single succinct summary.

IMPORTANT: Keep the summary concise and to the point. SUMMARIES MUST BE LESS THAN 250 CHARACTERS.

Respond with ONLY a JSON object in this format: {"summary": "your summary here"}

Summaries:
${JSON.stringify(nodeSummaries, null, 2)}`
    }
  ];
}

export function summaryDescriptionPrompt(summary: string): Message[] {
  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant that describes provided contents in a single sentence.'
    },
    {
      role: 'user',
      content: `Create a short one sentence description of the summary that explains what kind of information is summarized.
Descriptions must be under 250 characters.

Respond with ONLY a JSON object in this format: {"description": "your description here"}

Summary:
${JSON.stringify(summary)}`
    }
  ];
}

// ---------------------------------------------------------------------------
// Batched prompts — multiple communities in a single LLM call
// ---------------------------------------------------------------------------

/**
 * Prompt to summarize multiple communities at once.
 * Each community is a group of member entity summaries.
 * Returns a JSON array of one summary per community.
 */
export function batchSummarizePrompt(communities: string[][]): Message[] {
  const items = communities.map((memberSummaries, i) => ({
    community: i + 1,
    member_summaries: memberSummaries,
  }));

  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that synthesizes entity summaries into community summaries.'
    },
    {
      role: 'user',
      content: `Below are ${communities.length} communities, each with a list of member entity summaries.
For EACH community, synthesize all its member summaries into a single concise community summary.

RULES:
- Each summary MUST be under 250 characters.
- Capture the core theme that unifies the members.
- Do NOT list individual members — describe what they have in common.

Respond with ONLY a JSON array of ${communities.length} summary strings, one per community, in order.
Example format: ["summary for community 1", "summary for community 2", ...]

Communities:
${JSON.stringify(items, null, 2)}`
    }
  ];
}

/**
 * Prompt to generate short names for multiple community summaries at once.
 * Returns a JSON array of one name per summary.
 */
export function batchNamePrompt(summaries: string[]): Message[] {
  const items = summaries.map((s, i) => ({ community: i + 1, summary: s }));

  return [
    {
      role: 'system',
      content: 'You are a helpful assistant that creates short descriptive names.'
    },
    {
      role: 'user',
      content: `Below are ${summaries.length} community summaries.
For EACH, create a short descriptive name (under 100 characters) that explains what kind of information the community contains.

Respond with ONLY a JSON array of ${summaries.length} name strings, one per community, in order.
Example format: ["name for community 1", "name for community 2", ...]

Summaries:
${JSON.stringify(items, null, 2)}`
    }
  ];
}
