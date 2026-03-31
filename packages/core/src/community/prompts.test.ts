import { describe, expect, test } from 'bun:test';

import { summarizePairPrompt, summaryDescriptionPrompt } from './prompts';

describe('community prompts', () => {
  test('summarizePairPrompt returns system and user messages', () => {
    const messages = summarizePairPrompt(['Summary A', 'Summary B']);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('combines summaries');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('Summary A');
    expect(messages[1]!.content).toContain('Summary B');
    expect(messages[1]!.content).toContain('250 CHARACTERS');
    expect(messages[1]!.content).toContain('JSON');
  });

  test('summaryDescriptionPrompt returns system and user messages', () => {
    const messages = summaryDescriptionPrompt('A community about technology');

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('single sentence');
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('A community about technology');
    expect(messages[1]!.content).toContain('JSON');
  });
});
