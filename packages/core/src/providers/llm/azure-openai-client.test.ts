import { describe, expect, test } from 'bun:test';

import { AzureOpenAIClient } from './azure-openai-client';
import { EmptyResponseError } from '../errors';

function createMockClient(responseContent: string) {
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

describe('AzureOpenAIClient', () => {
  test('generates text from messages', async () => {
    const client = new AzureOpenAIClient({ client: createMockClient('{"ok": true}') });
    const result = await client.generateText([{ role: 'user', content: 'test' }]);
    expect(result).toBe('{"ok": true}');
  });

  test('exposes default model names', () => {
    const client = new AzureOpenAIClient({ client: createMockClient('') });
    expect(client.model).toBe('gpt-4o');
    expect(client.small_model).toBe('gpt-4o-mini');
  });

  test('uses configured deployment name as model', () => {
    const client = new AzureOpenAIClient({
      config: { model: 'my-gpt4-deployment' },
      client: createMockClient('')
    });
    expect(client.model).toBe('my-gpt4-deployment');
  });

  test('throws EmptyResponseError for empty content', async () => {
    const client = new AzureOpenAIClient({ client: createMockClient('') });
    await expect(client.generateText([{ role: 'user', content: 'test' }])).rejects.toThrow(EmptyResponseError);
  });
});
