import { describe, expect, test } from 'bun:test';

import { OpenAIRerankerClient } from './openai-reranker';

function createMockOpenAI(responses: Array<{ token: string; logprob: number }[]>) {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const topLogprobs = responses[callIndex] ?? [];
          callIndex++;
          return {
            choices: [
              {
                logprobs: {
                  content: [{ top_logprobs: topLogprobs }]
                }
              }
            ]
          };
        }
      }
    }
  } as any;
}

describe('OpenAIRerankerClient', () => {
  test('scores and sorts passages by relevance', async () => {
    const reranker = new OpenAIRerankerClient({
      client: createMockOpenAI([
        [{ token: 'True', logprob: Math.log(0.9) }],
        [{ token: 'True', logprob: Math.log(0.3) }],
        [{ token: 'True', logprob: Math.log(0.7) }]
      ])
    });

    const results = await reranker.rank('what is graphiti?', [
      'Graphiti is a knowledge graph',
      'The weather is sunny',
      'Graphiti supports Neo4j'
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]?.[0]).toBe('Graphiti is a knowledge graph');
    expect(results[0]?.[1]).toBeCloseTo(0.9, 1);
    expect(results[1]?.[0]).toBe('Graphiti supports Neo4j');
    expect(results[2]?.[0]).toBe('The weather is sunny');
  });

  test('inverts score for False tokens', async () => {
    const reranker = new OpenAIRerankerClient({
      client: createMockOpenAI([
        [{ token: 'False', logprob: Math.log(0.8) }]
      ])
    });

    const results = await reranker.rank('query', ['passage']);

    expect(results[0]?.[1]).toBeCloseTo(0.2, 1);
  });

  test('handles empty logprobs gracefully', async () => {
    const reranker = new OpenAIRerankerClient({
      client: createMockOpenAI([[]])
    });

    const results = await reranker.rank('query', ['passage']);

    expect(results[0]?.[1]).toBe(0);
  });

  test('handles empty passages list', async () => {
    const reranker = new OpenAIRerankerClient({
      client: createMockOpenAI([])
    });

    const results = await reranker.rank('query', []);

    expect(results).toEqual([]);
  });
});
