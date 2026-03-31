import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import { EpisodeTypes, type EpisodicNode } from '../domain/nodes';
import {
  buildEpisodeExtractionPrompt,
  extractEntityEdges,
  extractEntityNames,
  HeuristicEpisodeExtractor,
  mapModelExtractionResponse,
  ModelEpisodeExtractor,
  parseModelExtractionResponse
} from './extractor';

describe('heuristic episode extractor', () => {
  test('extracts capitalized entity names from content', () => {
    expect(extractEntityNames('Alice knows Bob. Later Carol greeted Alice.')).toEqual([
      'Alice',
      'Bob',
      'Carol'
    ]);
  });

  test('extracts heuristic edges from content', () => {
    const extractor = new HeuristicEpisodeExtractor();

    const episode: EpisodicNode = {
      uuid: 'episode-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice knows Bob. Carol greeted Alice.',
      valid_at: utcNow(),
      entity_edges: []
    };

    return extractor.extract({ episode, previous_episodes: [] }).then((result) => {
      expect(result.entities.map((entity) => entity.name)).toEqual(['Alice', 'Bob', 'Carol']);
      expect(result.entity_edges.map((edge) => edge.name)).toEqual(['knows', 'greeted']);
      expect(result.entity_edges.map((edge) => edge.fact)).toEqual([
        'Alice knows Bob',
        'Carol greeted Alice'
      ]);
    });
  });

  test('deduplicates repeated edge mentions', () => {
    const entityByName = new Map([
      [
        'Alice',
        {
          uuid: 'entity-1',
          name: 'Alice',
          group_id: 'group',
          labels: [],
          created_at: utcNow(),
          summary: ''
        }
      ],
      [
        'Bob',
        {
          uuid: 'entity-2',
          name: 'Bob',
          group_id: 'group',
          labels: [],
          created_at: utcNow(),
          summary: ''
        }
      ]
    ]);

    const edges = extractEntityEdges(
      'Alice knows Bob. Alice knows Bob.',
      entityByName,
      {
        uuid: 'episode-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: utcNow(),
        source: EpisodeTypes.text,
        source_description: 'chat',
        content: '',
        valid_at: utcNow(),
        entity_edges: []
      }
    );

    expect(edges).toHaveLength(1);
  });

  test('collapses heuristic alias mentions onto the canonical entity', async () => {
    const extractor = new HeuristicEpisodeExtractor();
    const episode: EpisodicNode = {
      uuid: 'episode-alias-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Robert, also known as Bob. Bob knows Alice.',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = await extractor.extract({ episode, previous_episodes: [] });
    const robert = result.entities.find((entity) => entity.name === 'Robert');

    expect(result.entities.map((entity) => entity.name).sort()).toEqual(['Alice', 'Robert']);
    expect(robert?.attributes?.aliases).toEqual(['Bob']);
    expect(result.entity_edges).toHaveLength(1);
    expect(result.entity_edges[0]?.source_node_uuid).toBe(robert?.uuid);
  });

  test('parses model extraction responses into graph entities and edges', () => {
    const episode: EpisodicNode = {
      uuid: 'episode-2',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'ignored',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = mapModelExtractionResponse(
      { episode, previous_episodes: [] },
      JSON.stringify({
        entities: [
          { name: 'Alice', labels: ['Person'], summary: 'Engineer', aliases: ['Alicia'] }
        ],
        entity_edges: [
          {
            source: 'Alicia',
            target: 'Bob',
            name: 'Works With',
            fact: 'Alice works with Bob'
          }
        ]
      })
    );

    expect(result.entities.map((entity) => entity.name)).toEqual(['Alice', 'Bob']);
    expect(result.entities[0]?.labels).toEqual(['Person']);
    expect(result.entities[0]?.attributes?.aliases).toEqual(['Alicia']);
    expect(result.entities[1]?.labels).toEqual(['Extracted', 'Model']);
    expect(result.entity_edges).toHaveLength(1);
    expect(result.entity_edges[0]?.name).toBe('works_with');
    expect(result.entity_edges[0]?.source_node_uuid).toBe(result.entities[0]?.uuid);
  });

  test('accepts fenced json model responses', () => {
    const parsed = parseModelExtractionResponse(
      '```json\n{"entities":[{"name":"Alice"}],"entity_edges":[]}\n```'
    );

    expect(parsed.entities?.[0]?.name).toBe('Alice');
  });

  test('uses the model-backed extractor when the response is valid', async () => {
    const extractor = new ModelEpisodeExtractor(new FakeLLMClient());
    const episode: EpisodicNode = {
      uuid: 'episode-3',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice works with Bob',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = await extractor.extract({ episode, previous_episodes: [] });

    expect(result.entities.map((entity) => entity.name)).toEqual(['Alice', 'Bob']);
    expect(result.entities[0]?.attributes?.aliases).toEqual(['Alicia']);
    expect(result.entity_edges[0]?.name).toBe('works_with');
  });

  test('falls back to the heuristic extractor when model output is invalid', async () => {
    const fallback = new HeuristicEpisodeExtractor();
    const extractor = new ModelEpisodeExtractor(new BrokenLLMClient(), fallback);
    const episode: EpisodicNode = {
      uuid: 'episode-4',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = await extractor.extract({ episode, previous_episodes: [] });

    expect(result.entity_edges[0]?.name).toBe('knows');
  });

  test('falls back to the heuristic extractor when model output is parseable but invalid', async () => {
    const fallback = new HeuristicEpisodeExtractor();
    const extractor = new ModelEpisodeExtractor(new InvalidShapeLLMClient(), fallback);
    const episode: EpisodicNode = {
      uuid: 'episode-4b',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = await extractor.extract({ episode, previous_episodes: [] });

    expect(result.entity_edges[0]?.name).toBe('knows');
  });

  test('builds a structured extraction prompt with episode context', () => {
    const messages = buildEpisodeExtractionPrompt({
      episode: {
        uuid: 'episode-5',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: utcNow(),
        source: EpisodeTypes.text,
        source_description: 'chat',
        content: 'Alice met Bob',
        valid_at: utcNow(),
        entity_edges: []
      },
      previous_episodes: []
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toContain('Alice met Bob');
  });
});

class FakeLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [{ name: 'Alice', labels: ['Person'], summary: 'Engineer', aliases: ['Alicia'] }],
      entity_edges: [
        {
          source: 'Alicia',
          target: 'Bob',
          name: 'works_with',
          fact: 'Alice works with Bob'
        }
      ]
    });
  }
}

class BrokenLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return 'not json';
  }
}

class InvalidShapeLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [{ name: 123 }],
      entity_edges: []
    });
  }
}
