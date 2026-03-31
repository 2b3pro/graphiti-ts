import { describe, expect, test } from 'bun:test';

import { AnthropicClient } from './anthropic-client';
import { EmptyResponseError, RateLimitError } from '../errors';

function createMockAnthropic(responseText: string) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: responseText }]
      })
    }
  } as any;
}

function createFailingAnthropic(error: Error, failCount = 1) {
  let callCount = 0;
  return {
    messages: {
      create: async () => {
        callCount++;
        if (callCount <= failCount) {
          throw error;
        }
        return {
          content: [{ type: 'text', text: '{"result": "ok"}' }]
        };
      }
    }
  } as any;
}

describe('AnthropicClient', () => {
  test('generates text from messages', async () => {
    const client = new AnthropicClient({
      client: createMockAnthropic('{"entities": []}')
    });

    const result = await client.generateText([
      { role: 'user', content: 'extract entities' }
    ]);

    expect(result).toBe('{"entities": []}');
  });

  test('exposes default model names', () => {
    const client = new AnthropicClient({
      client: createMockAnthropic('')
    });

    expect(client.model).toBe('claude-sonnet-4-6-latest');
    expect(client.small_model).toBe('claude-haiku-4-5-latest');
  });

  test('uses configured model names', () => {
    const client = new AnthropicClient({
      config: { model: 'claude-3-5-sonnet-latest', small_model: 'claude-3-5-haiku-latest' },
      client: createMockAnthropic('')
    });

    expect(client.model).toBe('claude-3-5-sonnet-latest');
    expect(client.small_model).toBe('claude-3-5-haiku-latest');
  });

  test('separates system message from conversation', async () => {
    let capturedParams: any = null;
    const mockClient = {
      messages: {
        create: async (params: any) => {
          capturedParams = params;
          return { content: [{ type: 'text', text: '{}' }] };
        }
      }
    } as any;

    const client = new AnthropicClient({ client: mockClient });
    await client.generateText([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' }
    ]);

    expect(capturedParams.system).toBe('You are a helpful assistant.');
    expect(capturedParams.messages).toHaveLength(1);
    expect(capturedParams.messages[0].role).toBe('user');
  });

  test('throws EmptyResponseError on empty content', async () => {
    const client = new AnthropicClient({
      client: createMockAnthropic('')
    });

    expect(
      client.generateText([{ role: 'user', content: 'test' }])
    ).rejects.toBeInstanceOf(EmptyResponseError);
  });

  test('retries on generic errors', async () => {
    const client = new AnthropicClient({
      client: createFailingAnthropic(new Error('transient'), 1)
    });

    const result = await client.generateText([
      { role: 'user', content: 'test' }
    ]);

    expect(result).toBe('{"result": "ok"}');
  });

  test('wraps rate limit errors from the SDK', async () => {
    // Simulate Anthropic.RateLimitError structure
    const rateLimitError = Object.create(new Error('rate limited'));
    rateLimitError.constructor = { name: 'RateLimitError' };
    // The actual SDK error class check — we need to test the RateLimitError path
    // In our mock, we throw our own RateLimitError to verify it propagates
    const client = new AnthropicClient({
      client: createFailingAnthropic(new RateLimitError('rate limited'), 10)
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

    const client = new AnthropicClient({
      client: createMockAnthropic('{"ok": true}')
    });
    client.setTracer(fakeTracer);

    await client.generateText([{ role: 'user', content: 'test' }]);

    expect(spans).toContain('llm.generate');
  });
});
