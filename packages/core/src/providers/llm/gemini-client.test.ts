import { describe, expect, test } from 'bun:test';

import { GeminiClient } from './gemini-client';
import { EmptyResponseError, RateLimitError } from '../errors';

function createMockModel(responseText: string) {
  return {
    generateContent: async () => ({
      response: {
        text: () => responseText
      }
    })
  } as any;
}

function createFailingModel(error: Error, failCount = 1) {
  let callCount = 0;
  return {
    generateContent: async () => {
      callCount++;
      if (callCount <= failCount) {
        throw error;
      }
      return {
        response: {
          text: () => '{"result": "ok"}'
        }
      };
    }
  } as any;
}

describe('GeminiClient', () => {
  test('generates text from messages', async () => {
    const client = new GeminiClient({
      model: createMockModel('{"entities": []}')
    });

    const result = await client.generateText([
      { role: 'user', content: 'extract entities' }
    ]);

    expect(result).toBe('{"entities": []}');
  });

  test('exposes default model names', () => {
    const client = new GeminiClient({
      model: createMockModel('')
    });

    expect(client.model).toBe('gemini-3-flash-preview');
    expect(client.small_model).toBe('gemini-3-flash-preview');
  });

  test('uses configured model names', () => {
    const client = new GeminiClient({
      config: { model: 'gemini-2.5-pro', small_model: 'gemini-3-flash-preview' },
      model: createMockModel('')
    });

    expect(client.model).toBe('gemini-2.5-pro');
    expect(client.small_model).toBe('gemini-3-flash-preview');
  });

  test('converts system messages to systemInstruction', async () => {
    let capturedRequest: any = null;
    const mockModel = {
      generateContent: async (request: any) => {
        capturedRequest = request;
        return { response: { text: () => '{}' } };
      }
    } as any;

    const client = new GeminiClient({ model: mockModel });
    await client.generateText([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ]);

    expect(capturedRequest.systemInstruction).toBe('You are helpful.');
    expect(capturedRequest.contents).toHaveLength(1);
    expect(capturedRequest.contents[0].role).toBe('user');
  });

  test('maps assistant role to model role', async () => {
    let capturedRequest: any = null;
    const mockModel = {
      generateContent: async (request: any) => {
        capturedRequest = request;
        return { response: { text: () => '{}' } };
      }
    } as any;

    const client = new GeminiClient({ model: mockModel });
    await client.generateText([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Tell me more' }
    ]);

    expect(capturedRequest.contents[1].role).toBe('model');
  });

  test('throws EmptyResponseError on empty content', async () => {
    const client = new GeminiClient({
      model: createMockModel('')
    });

    expect(
      client.generateText([{ role: 'user', content: 'test' }])
    ).rejects.toBeInstanceOf(EmptyResponseError);
  });

  test('retries on generic errors', async () => {
    const client = new GeminiClient({
      model: createFailingModel(new Error('transient'), 1)
    });

    const result = await client.generateText([
      { role: 'user', content: 'test' }
    ]);

    expect(result).toBe('{"result": "ok"}');
  });

  test('wraps 429 errors as RateLimitError', async () => {
    const client = new GeminiClient({
      model: createFailingModel(new Error('429 Resource has been exhausted'), 10)
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

    const client = new GeminiClient({
      model: createMockModel('{"ok": true}')
    });
    client.setTracer(fakeTracer);

    await client.generateText([{ role: 'user', content: 'test' }]);

    expect(spans).toContain('llm.generate');
  });
});
