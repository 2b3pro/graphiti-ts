import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';

import { JinaRerankerClient } from './jina-reranker';

// Mock fetch globally for these tests
const originalFetch = globalThis.fetch;

function mockFetch(responseBody: unknown, status = 200) {
  globalThis.fetch = mock(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  })) as any;
}

describe('JinaRerankerClient', () => {
  beforeEach(() => {
    process.env.JINA_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JINA_API_KEY;
  });

  test('throws if no API key provided', () => {
    delete process.env.JINA_API_KEY;
    expect(() => new JinaRerankerClient()).toThrow('Jina API key required');
  });

  test('accepts API key from options', () => {
    delete process.env.JINA_API_KEY;
    const client = new JinaRerankerClient({ apiKey: 'explicit-key' });
    expect(client).toBeDefined();
  });

  test('accepts API key from env var', () => {
    const client = new JinaRerankerClient();
    expect(client).toBeDefined();
  });

  test('scores and sorts passages by relevance', async () => {
    mockFetch({
      results: [
        { index: 0, relevance_score: 0.95 },
        { index: 1, relevance_score: 0.12 },
        { index: 2, relevance_score: 0.78 },
      ],
    });

    const reranker = new JinaRerankerClient();
    const results = await reranker.rank('what is graphiti?', [
      'Graphiti is a knowledge graph',
      'The weather is sunny',
      'Graphiti supports Neo4j',
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]?.[0]).toBe('Graphiti is a knowledge graph');
    expect(results[0]?.[1]).toBe(0.95);
    expect(results[1]?.[0]).toBe('Graphiti supports Neo4j');
    expect(results[1]?.[1]).toBe(0.78);
    expect(results[2]?.[0]).toBe('The weather is sunny');
    expect(results[2]?.[1]).toBe(0.12);
  });

  test('handles empty passages list', async () => {
    const reranker = new JinaRerankerClient();
    const results = await reranker.rank('query', []);
    expect(results).toEqual([]);
  });

  test('sends correct request body', async () => {
    mockFetch({ results: [{ index: 0, relevance_score: 0.5 }] });

    const reranker = new JinaRerankerClient({ model: 'jina-reranker-v3', topN: 5 });
    await reranker.rank('test query', ['passage one']);

    const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.jina.ai/v1/rerank');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('jina-reranker-v3');
    expect(body.query).toBe('test query');
    expect(body.documents).toEqual(['passage one']);
    expect(body.return_documents).toBe(false);
    expect(body.top_n).toBe(5);

    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Accept']).toBe('application/json');
  });

  test('omits top_n when not specified', async () => {
    mockFetch({ results: [{ index: 0, relevance_score: 0.5 }] });

    const reranker = new JinaRerankerClient();
    await reranker.rank('query', ['passage']);

    const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.top_n).toBeUndefined();
  });

  test('throws on API error with message', async () => {
    mockFetch({ detail: 'Invalid API key' }, 401);

    const reranker = new JinaRerankerClient();
    await expect(reranker.rank('query', ['passage'])).rejects.toThrow(
      'Jina Reranker request failed: 401'
    );
  });

  test('handles single passage', async () => {
    mockFetch({
      results: [{ index: 0, relevance_score: 0.99 }],
    });

    const reranker = new JinaRerankerClient();
    const results = await reranker.rank('query', ['only passage']);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(['only passage', 0.99]);
  });

  test('uses default model jina-reranker-v3', async () => {
    mockFetch({ results: [{ index: 0, relevance_score: 0.5 }] });

    const reranker = new JinaRerankerClient();
    await reranker.rank('q', ['p']);

    const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('jina-reranker-v3');
  });
});
