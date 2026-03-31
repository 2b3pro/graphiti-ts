import { describe, expect, test } from 'bun:test';

import { GroqClient } from './groq-client';
import { EmptyResponseError, RateLimitError } from '../errors';

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

describe('GroqClient', () => {
  test('generates text from messages', async () => {
    const client = new GroqClient({ client: createMockOpenAI('{"entities": []}') });
    const result = await client.generateText([{ role: 'user', content: 'extract' }]);
    expect(result).toBe('{"entities": []}');
  });

  test('exposes default model names', () => {
    const client = new GroqClient({ client: createMockOpenAI('') });
    expect(client.model).toBe('llama-3.3-70b-versatile');
    expect(client.small_model).toBe('llama-3.1-8b-instant');
  });

  test('uses configured model', () => {
    const client = new GroqClient({
      config: { model: 'mixtral-8x7b-32768' },
      client: createMockOpenAI('')
    });
    expect(client.model).toBe('mixtral-8x7b-32768');
  });

  test('throws EmptyResponseError for empty content', async () => {
    const client = new GroqClient({ client: createMockOpenAI('') });
    await expect(client.generateText([{ role: 'user', content: 'test' }])).rejects.toThrow(EmptyResponseError);
  });
});
