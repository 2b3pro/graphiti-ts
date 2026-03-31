import type { Message } from '../prompts/types';

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
