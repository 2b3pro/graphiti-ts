import { describe, expect, test } from 'bun:test';

import { OpenAIClient } from './openai-client';
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

function createFailingOpenAI(error: Error, failCount = 1) {
  let callCount = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          if (callCount <= failCount) {
            throw error;
          }
          return {
            choices: [{ message: { content: '{"result": "ok"}' } }]
          };
        }
      }
    }
  } as any;
}

describe('OpenAIClient', () => {
  test('generates text from messages', async () => {
    const client = new OpenAIClient({
      client: createMockOpenAI('{"entities": []}')
    });

    const result = await client.generateText([
      { role: 'user', content: 'extract entities' }
    ]);

    expect(result).toBe('{"entities": []}');
  });

  test('exposes default model names', () => {
    const client = new OpenAIClient({
      client: createMockOpenAI('')
    });

    expect(client.model).toBe('gpt-4.1-mini');
    expect(client.small_model).toBe('gpt-4.1-nano');
  });

  test('uses configured model names', () => {
    const client = new OpenAIClient({
      config: { model: 'gpt-4o', small_model: 'gpt-4o-mini' },
      client: createMockOpenAI('')
    });

    expect(client.model).toBe('gpt-4o');
    expect(client.small_model).toBe('gpt-4o-mini');
  });

  test('cleans control characters and zero-width chars from input', async () => {
    let capturedMessages: any[] = [];
    const mockClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedMessages = params.messages;
            return { choices: [{ message: { content: '{}' } }] };
          }
        }
      }
    } as any;

    const client = new OpenAIClient({ client: mockClient });
    await client.generateText([
      { role: 'user', content: 'hello\u200b\u200cworld\x00\x01' }
    ]);

    expect(capturedMessages[0].content).toBe('helloworld');
  });

  test('throws EmptyResponseError on empty content', async () => {
    const client = new OpenAIClient({
      client: createMockOpenAI('')
    });

    expect(
      client.generateText([{ role: 'user', content: 'test' }])
    ).rejects.toBeInstanceOf(EmptyResponseError);
  });

  test('retries on generic errors', async () => {
    const client = new OpenAIClient({
      client: createFailingOpenAI(new Error('transient'), 1)
    });

    const result = await client.generateText([
      { role: 'user', content: 'test' }
    ]);

    expect(result).toBe('{"result": "ok"}');
  });

  test('does not retry on RateLimitError', async () => {
    const client = new OpenAIClient({
      client: createFailingOpenAI(new RateLimitError(), 1)
    });

    expect(
      client.generateText([{ role: 'user', content: 'test' }])
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  test('integrates tracer spans', async () => {
    const spans: string[] = [];
    const fakeTracer = {
      startSpan(name: string) {
        spans.push(name);
        return {
          span: {
            addAttributes() {},
            setStatus() {},
            recordException() {}
          },
          close() {}
        };
      }
    };

    const client = new OpenAIClient({
      client: createMockOpenAI('{"ok": true}')
    });
    client.setTracer(fakeTracer);

    await client.generateText([{ role: 'user', content: 'test' }]);

    expect(spans).toContain('llm.generate');
  });
});
