import { describe, expect, test } from 'bun:test';

import { cleanInput, generateResponse, type GenerateResponseContext } from './generate-response';
import { LLMCache } from './cache';
import { TokenUsageTracker } from './token-tracker';
import type { LLMClient } from '../contracts';
import type { Message } from '../prompts/types';

// ---------------------------------------------------------------------------
// Mock LLM Client
// ---------------------------------------------------------------------------

function createMockLLMClient(responseText: string): LLMClient {
  return {
    model: 'test-model',
    small_model: 'test-model-small',
    setTracer: () => {},
    generateText: async (_messages: Message[]) => responseText
  };
}

function createCapturingLLMClient(responseText: string): {
  client: LLMClient;
  capturedMessages: Message[][];
} {
  const capturedMessages: Message[][] = [];
  const client: LLMClient = {
    model: 'test-model',
    small_model: 'test-model-small',
    setTracer: () => {},
    generateText: async (messages: Message[]) => {
      capturedMessages.push(messages);
      return responseText;
    }
  };
  return { client, capturedMessages };
}

// ---------------------------------------------------------------------------
// cleanInput
// ---------------------------------------------------------------------------

describe('cleanInput', () => {
  test('removes zero-width characters', () => {
    const input = 'hello\u200bworld\u200c!\ufeff';
    expect(cleanInput(input)).toBe('helloworld!');
  });

  test('removes control characters but keeps newlines and tabs', () => {
    const input = 'line1\nline2\ttab\x00null\x01soh';
    const result = cleanInput(input);
    expect(result).toContain('line1\nline2\ttab');
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('\x01');
  });

  test('returns empty string for empty input', () => {
    expect(cleanInput('')).toBe('');
  });

  test('leaves normal text unchanged', () => {
    const text = 'Hello, World! This is normal text.';
    expect(cleanInput(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// generateResponse
// ---------------------------------------------------------------------------

describe('generateResponse', () => {
  test('parses plain JSON response', async () => {
    const client = createMockLLMClient('{"entities": ["Alice", "Bob"]}');
    const result = await generateResponse(client, [
      { role: 'user', content: 'extract entities' }
    ]);
    expect(result).toEqual({ entities: ['Alice', 'Bob'] });
  });

  test('extracts JSON from markdown code block', async () => {
    const client = createMockLLMClient('```json\n{"result": 42}\n```');
    const result = await generateResponse(client, [
      { role: 'user', content: 'question' }
    ]);
    expect(result).toEqual({ result: 42 });
  });

  test('extracts JSON from unmarked code block', async () => {
    const client = createMockLLMClient('```\n{"result": "ok"}\n```');
    const result = await generateResponse(client, [
      { role: 'user', content: 'question' }
    ]);
    expect(result).toEqual({ result: 'ok' });
  });

  test('extracts JSON object from mixed text', async () => {
    const client = createMockLLMClient('Here is the answer: {"value": true} hope that helps');
    const result = await generateResponse(client, [
      { role: 'user', content: 'question' }
    ]);
    expect(result).toEqual({ value: true });
  });

  test('throws on completely non-JSON response', async () => {
    const client = createMockLLMClient('just plain text with no JSON at all');
    await expect(
      generateResponse(client, [{ role: 'user', content: 'question' }])
    ).rejects.toThrow('Failed to parse LLM response as JSON');
  });

  test('appends response_model schema to last user message', async () => {
    const { client, capturedMessages } = createCapturingLLMClient('{"ok": true}');
    await generateResponse(
      client,
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Do something.' }
      ],
      { response_model: { type: 'object', properties: { ok: { type: 'boolean' } } } }
    );

    const lastMsg = capturedMessages[0]![1]!;
    expect(lastMsg.content).toContain('Respond with a JSON object');
    expect(lastMsg.content).toContain('"type":"object"');
  });

  test('appends language instruction to first message', async () => {
    const { client, capturedMessages } = createCapturingLLMClient('{"ok": true}');
    await generateResponse(client, [
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'Hello.' }
    ]);

    const firstMsg = capturedMessages[0]![0]!;
    expect(firstMsg.content).toContain('language');
  });

  test('cleans input of control characters', async () => {
    const { client, capturedMessages } = createCapturingLLMClient('{"ok": true}');
    await generateResponse(client, [
      { role: 'user', content: 'hello\x00world\u200b!' }
    ]);

    const msg = capturedMessages[0]![0]!;
    expect(msg.content).not.toContain('\x00');
    expect(msg.content).not.toContain('\u200b');
  });

  test('does not mutate original messages array', async () => {
    const client = createMockLLMClient('{"ok": true}');
    const original: Message[] = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: 'User.' }
    ];
    const originalContent = original[0]!.content;
    await generateResponse(client, original, {
      response_model: { type: 'object' }
    });
    expect(original[0]!.content).toBe(originalContent);
    expect(original[1]!.content).toBe('User.');
  });

  // Cache tests
  test('uses cache on second identical call', async () => {
    let callCount = 0;
    const client: LLMClient = {
      model: 'test',
      small_model: 'test-small',
      setTracer: () => {},
      generateText: async () => {
        callCount++;
        return '{"result": "fresh"}';
      }
    };
    const cache = new LLMCache();
    const ctx: GenerateResponseContext = { cache };

    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    const result1 = await generateResponse(client, messages, {}, ctx);
    const result2 = await generateResponse(client, messages, {}, ctx);

    expect(callCount).toBe(1); // Only one real call
    expect(result1).toEqual(result2);
  });

  // Token tracking tests
  test('records token usage when tokenTracker and prompt_name provided', async () => {
    const client = createMockLLMClient('{"ok": true}');
    const tracker = new TokenUsageTracker();
    const ctx: GenerateResponseContext = { tokenTracker: tracker };

    await generateResponse(
      client,
      [{ role: 'user', content: 'Hello' }],
      { prompt_name: 'test_prompt' },
      ctx
    );

    const usage = tracker.getUsage();
    expect(usage.has('test_prompt')).toBe(true);
    const entry = usage.get('test_prompt')!;
    expect(entry.call_count).toBe(1);
    expect(entry.total_input_tokens).toBeGreaterThan(0);
    expect(entry.total_output_tokens).toBeGreaterThan(0);
  });

  test('does not track tokens when prompt_name is missing', async () => {
    const client = createMockLLMClient('{"ok": true}');
    const tracker = new TokenUsageTracker();
    const ctx: GenerateResponseContext = { tokenTracker: tracker };

    await generateResponse(client, [{ role: 'user', content: 'Hello' }], {}, ctx);

    expect(tracker.getUsage().size).toBe(0);
  });
});
