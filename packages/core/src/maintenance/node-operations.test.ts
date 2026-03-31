import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { GraphitiClients, LLMClient, EmbedderClient, GraphDriver } from '../contracts';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import type { Message } from '../prompts/types';

import { buildEntityTypesContext, extractNodes, resolveExtractedNodes, extractAttributesFromNodes } from './node-operations';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEpisode(overrides: Partial<EpisodicNode> = {}): EpisodicNode {
  return {
    uuid: 'ep-1',
    name: 'episode-1',
    group_id: 'g1',
    labels: ['Episodic'],
    created_at: utcNow(),
    source: 'message',
    source_description: 'test',
    content: 'Alice met Bob at the coffee shop.',
    valid_at: utcNow(),
    ...overrides
  };
}

function makeNode(uuid: string, name: string, overrides: Partial<EntityNode> = {}): EntityNode {
  return {
    uuid,
    name,
    group_id: 'g1',
    labels: ['Entity'],
    created_at: utcNow(),
    summary: '',
    ...overrides
  };
}

function makeMockLLMClient(responses: Record<string, unknown>[]): LLMClient {
  let callIndex = 0;
  return {
    model: 'test-model',
    small_model: 'test-small',
    setTracer: () => {},
    generateText: async (_messages: Message[]) => {
      const resp = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return JSON.stringify(resp);
    }
  };
}

function makeMockEmbedder(): EmbedderClient {
  return {
    create: async (texts: string[]) => {
      // Return a simple deterministic embedding
      return texts[0]!.split('').map((_, i) => (i % 10) / 10);
    }
  };
}

function makeMockDriver(): GraphDriver {
  return {
    provider: 'mock',
    default_group_id: 'g1',
    database: 'test',
    session: () => ({ close: async () => {}, executeQuery: async () => ({ records: [] }) }),
    transaction: () =>
      ({
        run: async () => ({ records: [] }),
        commit: async () => {},
        rollback: async () => {}
      }) as any,
    close: async () => {},
    deleteAllIndexes: async () => {},
    buildIndicesAndConstraints: async () => {},
    executeQuery: async () => ({ records: [] })
  } as any;
}

function makeMockClients(
  llmResponses: Record<string, unknown>[]
): GraphitiClients {
  return {
    llm_client: makeMockLLMClient(llmResponses),
    embedder: makeMockEmbedder(),
    driver: makeMockDriver()
  } as any;
}

// ---------------------------------------------------------------------------
// buildEntityTypesContext
// ---------------------------------------------------------------------------

describe('buildEntityTypesContext', () => {
  test('returns default Entity type when no entity types provided', () => {
    const result = buildEntityTypesContext();
    expect(result).toHaveLength(1);
    expect(result[0]!.entity_type_id).toBe(0);
    expect(result[0]!.entity_type_name).toBe('Entity');
  });

  test('returns default Entity type for null input', () => {
    const result = buildEntityTypesContext(null);
    expect(result).toHaveLength(1);
    expect(result[0]!.entity_type_name).toBe('Entity');
  });

  test('adds custom entity types after default', () => {
    const result = buildEntityTypesContext({
      Person: { description: 'A human being' },
      Organization: { description: 'A company or group' }
    });
    expect(result).toHaveLength(3);
    expect(result[0]!.entity_type_name).toBe('Entity');
    expect(result[1]!.entity_type_name).toBe('Person');
    expect(result[1]!.entity_type_description).toBe('A human being');
    expect(result[2]!.entity_type_name).toBe('Organization');
  });

  test('uses default description when not provided', () => {
    const result = buildEntityTypesContext({
      Custom: {}
    });
    expect(result[1]!.entity_type_description).toContain('Custom');
  });

  test('assigns sequential IDs starting from 1 for custom types', () => {
    const result = buildEntityTypesContext({
      A: { description: 'A' },
      B: { description: 'B' },
      C: { description: 'C' }
    });
    expect(result[1]!.entity_type_id).toBe(1);
    expect(result[2]!.entity_type_id).toBe(2);
    expect(result[3]!.entity_type_id).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// extractNodes
// ---------------------------------------------------------------------------

describe('extractNodes', () => {
  test('extracts entity nodes from LLM response', async () => {
    const clients = makeMockClients([
      {
        extracted_entities: [
          { name: 'Alice', entity_type_id: 0 },
          { name: 'Bob', entity_type_id: 0 }
        ]
      }
    ]);

    const episode = makeEpisode();
    const nodes = await extractNodes(clients, episode, []);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.name).toBe('Alice');
    expect(nodes[1]!.name).toBe('Bob');
    expect(nodes[0]!.group_id).toBe('g1');
    expect(nodes[0]!.labels).toContain('Entity');
  });

  test('filters out entities with empty names', async () => {
    const clients = makeMockClients([
      {
        extracted_entities: [
          { name: 'Alice', entity_type_id: 0 },
          { name: '', entity_type_id: 0 },
          { name: '  ', entity_type_id: 0 }
        ]
      }
    ]);

    const nodes = await extractNodes(clients, makeEpisode(), []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('Alice');
  });

  test('assigns correct labels based on entity type', async () => {
    const entityTypes = {
      Person: { description: 'A human' }
    };

    const clients = makeMockClients([
      {
        extracted_entities: [{ name: 'Alice', entity_type_id: 1 }]
      }
    ]);

    const nodes = await extractNodes(clients, makeEpisode(), [], entityTypes);
    expect(nodes[0]!.labels).toContain('Person');
    expect(nodes[0]!.labels).toContain('Entity');
  });

  test('excludes entities of excluded types', async () => {
    const entityTypes = {
      Person: { description: 'A human' },
      Bot: { description: 'A bot' }
    };

    const clients = makeMockClients([
      {
        extracted_entities: [
          { name: 'Alice', entity_type_id: 1 },
          { name: 'ChatBot', entity_type_id: 2 }
        ]
      }
    ]);

    const nodes = await extractNodes(
      clients,
      makeEpisode(),
      [],
      entityTypes,
      ['Bot']
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('Alice');
  });

  test('handles empty LLM response', async () => {
    const clients = makeMockClients([{ extracted_entities: [] }]);
    const nodes = await extractNodes(clients, makeEpisode(), []);
    expect(nodes).toHaveLength(0);
  });

  test('handles LLM response missing extracted_entities', async () => {
    const clients = makeMockClients([{}]);
    const nodes = await extractNodes(clients, makeEpisode(), []);
    expect(nodes).toHaveLength(0);
  });

  test('uses json prompt for json source type', async () => {
    const clients = makeMockClients([{ extracted_entities: [] }]);
    const episode = makeEpisode({ source: 'json' });
    const nodes = await extractNodes(clients, episode, []);
    expect(nodes).toHaveLength(0);
  });

  test('uses text prompt for text source type', async () => {
    const clients = makeMockClients([{ extracted_entities: [] }]);
    const episode = makeEpisode({ source: 'text' });
    const nodes = await extractNodes(clients, episode, []);
    expect(nodes).toHaveLength(0);
  });

  test('falls back to Entity label for out-of-range entity_type_id', async () => {
    const clients = makeMockClients([
      { extracted_entities: [{ name: 'Unknown', entity_type_id: 999 }] }
    ]);
    const nodes = await extractNodes(clients, makeEpisode(), []);
    expect(nodes[0]!.labels).toEqual(['Entity']);
  });
});

// ---------------------------------------------------------------------------
// resolveExtractedNodes
// ---------------------------------------------------------------------------

describe('resolveExtractedNodes', () => {
  test('returns empty arrays for empty input', async () => {
    const clients = makeMockClients([]);
    const [resolved, uuidMap, pairs] = await resolveExtractedNodes(clients, []);
    expect(resolved).toHaveLength(0);
    expect(Object.keys(uuidMap)).toHaveLength(0);
    expect(pairs).toHaveLength(0);
  });

  test('resolves nodes against existing nodes via exact match', async () => {
    const existingNode = makeNode('existing-1', 'Alice Johnson');

    // LLM won't be called for exact matches resolved by similarity
    const clients = makeMockClients([
      { entity_resolutions: [] }
    ]);

    const extracted = makeNode('new-1', 'alice johnson'); // same name, diff case

    const [resolved, uuidMap] = await resolveExtractedNodes(
      clients,
      [extracted],
      null,
      null,
      null,
      [existingNode]
    );

    expect(resolved).toHaveLength(1);
    // The resolved node should map to the existing one
    expect(uuidMap[extracted.uuid]).toBeDefined();
  });

  test('uses LLM for unresolved nodes', async () => {
    const existingNode = makeNode('existing-1', 'Alice Johnson');

    const clients = makeMockClients([
      {
        entity_resolutions: [
          { id: 0, name: 'Bob', duplicate_name: 'Alice Johnson' }
        ]
      }
    ]);

    const extracted = makeNode('new-1', 'Bob');

    const [resolved, uuidMap] = await resolveExtractedNodes(
      clients,
      [extracted],
      makeEpisode(),
      [],
      null,
      [existingNode]
    );

    expect(resolved).toHaveLength(1);
    // Bob should be resolved to Alice Johnson
    expect(uuidMap[extracted.uuid]).toBe(existingNode.uuid);
  });

  test('keeps node as-is when LLM finds no duplicate', async () => {
    const clients = makeMockClients([
      { entity_resolutions: [{ id: 0, name: 'UniqueEntity', duplicate_name: '' }] }
    ]);

    const extracted = makeNode('new-1', 'UniqueEntity');

    const [resolved, uuidMap] = await resolveExtractedNodes(
      clients,
      [extracted],
      makeEpisode(),
      [],
      null,
      []
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.uuid).toBe('new-1');
    expect(uuidMap['new-1']).toBe('new-1');
  });
});

// ---------------------------------------------------------------------------
// extractAttributesFromNodes
// ---------------------------------------------------------------------------

describe('extractAttributesFromNodes', () => {
  test('generates embeddings for nodes without embeddings', async () => {
    const clients = makeMockClients([
      { summaries: [{ name: 'Alice', summary: 'A person' }] }
    ]);

    const node = makeNode('n1', 'Alice');
    expect(node.name_embedding).toBeUndefined();

    const result = await extractAttributesFromNodes(clients, [node]);
    expect(result[0]!.name_embedding).toBeDefined();
    expect(Array.isArray(result[0]!.name_embedding)).toBe(true);
  });

  test('extracts attributes when entity type has fields', async () => {
    const clients = makeMockClients([
      { age: 30, occupation: 'engineer' },
      { summaries: [{ name: 'Alice', summary: 'A developer' }] }
    ]);

    const entityTypes = {
      Person: {
        description: 'A human',
        fields: { age: { type: 'number' }, occupation: { type: 'string' } }
      }
    };

    const node = makeNode('n1', 'Alice', { labels: ['Entity', 'Person'] });
    const result = await extractAttributesFromNodes(
      clients,
      [node],
      makeEpisode(),
      [],
      entityTypes
    );

    expect(result[0]!.attributes).toBeDefined();
  });

  test('skips attribute extraction when no entity type fields', async () => {
    const clients = makeMockClients([
      { summaries: [{ name: 'Alice', summary: 'A person' }] }
    ]);

    const node = makeNode('n1', 'Alice');
    const result = await extractAttributesFromNodes(clients, [node]);
    // Should still return the node
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Alice');
  });

  test('handles empty node array', async () => {
    const clients = makeMockClients([]);
    const result = await extractAttributesFromNodes(clients, []);
    expect(result).toHaveLength(0);
  });

  test('applies summaries from LLM to matching nodes', async () => {
    const clients = makeMockClients([
      { summaries: [{ name: 'Alice', summary: 'Software engineer at Acme' }] }
    ]);

    const node = makeNode('n1', 'Alice');
    // Force the node to need LLM summarization by adding a very long summary
    node.summary = 'x'.repeat(3000);

    const result = await extractAttributesFromNodes(
      clients,
      [node],
      makeEpisode()
    );

    expect(result[0]!.summary).toBe('Software engineer at Acme');
  });
});
