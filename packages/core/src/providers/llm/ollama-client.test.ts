import { describe, expect, test } from 'bun:test';

import { OllamaClient } from './ollama-client';
import { EmptyResponseError } from '../errors';

function createMockOpenAI(responseContent: string) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: responseContent } }]
        })
      }
    }
  } as any;
}

describe('OllamaClient', () => {
  test('generates text from messages', async () => {
    const client = new OllamaClient({
      client: createMockOpenAI('{"entities": []}')
    });

    const result = await client.generateText([
      { role: 'user', content: 'extract entities' }
    ]);

    expect(result).toBe('{"entities": []}');
  });

  test('exposes default model names', () => {
    const client = new OllamaClient({
      client: createMockOpenAI('')
    });

    expect(client.model).toBe('llama3.2');
    expect(client.small_model).toBe('llama3.2');
  });

  test('uses configured model names', () => {
    const client = new OllamaClient({
      config: { model: 'deepseek-r1:7b', small_model: 'qwen2:1.5b' },
      client: createMockOpenAI('')
    });

    expect(client.model).toBe('deepseek-r1:7b');
    expect(client.small_model).toBe('qwen2:1.5b');
  });

  test('throws EmptyResponseError for empty content', async () => {
    const client = new OllamaClient({
      client: createMockOpenAI('')
    });

    await expect(
      client.generateText([{ role: 'user', content: 'test' }])
    ).rejects.toThrow(EmptyResponseError);
  });

  test('retries on transient errors', async () => {
    let callCount = 0;
    const mockClient = {
      chat: {
        completions: {
          create: async () => {
            callCount++;
            if (callCount <= 1) throw new Error('connection refused');
            return { choices: [{ message: { content: '{"ok": true}' } }] };
          }
        }
      }
    } as any;

    const client = new OllamaClient({ client: mockClient });
    const result = await client.generateText([{ role: 'user', content: 'test' }]);
    expect(result).toBe('{"ok": true}');
    expect(callCount).toBe(2);
  });
});
