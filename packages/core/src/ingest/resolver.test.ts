import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type {
  AsyncDisposableTransaction,
  GraphDriver,
  GraphDriverSession,
  QueryOptions,
  QueryResult
} from '../contracts';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import type { EntityEdge } from '../domain/edges';
import { resolveEpisodeExtraction } from './resolver';

describe('episode extraction resolver', () => {
  test('reuses existing entities and merges existing edges', async () => {
    const driver = new FakeResolutionDriver();
    const episode: EpisodicNode = {
      uuid: 'episode-2',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: utcNow(),
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-alice',
          name: 'Alice',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        },
        {
          uuid: 'new-bob',
          name: 'Bob',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [
        {
          uuid: 'new-edge',
          group_id: 'group',
          source_node_uuid: 'new-alice',
          target_node_uuid: 'new-bob',
          created_at: utcNow(),
          name: 'knows',
          fact: 'Alice knows Bob',
          episodes: ['episode-2']
        }
      ] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entities.map((entity) => entity.uuid)).toEqual(['entity-1', 'entity-2']);
    expect(resolved.entity_edges).toHaveLength(1);
    expect(resolved.entity_edges[0]?.uuid).toBe('edge-1');
    expect(resolved.entity_edges[0]?.episodes).toEqual(['episode-1', 'episode-2']);
    expect(resolved.invalidated_edges).toHaveLength(0);
  });

  test('invalidates conflicting existing edges and keeps the new fact active', async () => {
    const existingTime = new Date('2026-03-29T12:00:00.000Z');
    const incomingTime = new Date('2026-03-30T12:00:00.000Z');
    const driver = new FakeResolutionDriver({
      existingEdges: [
        {
          uuid: 'edge-1',
          group_id: 'group',
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: existingTime.toISOString(),
          name: 'knows',
          fact: 'Alice dislikes Bob',
          fact_embedding: null,
          episodes: ['episode-1'],
          expired_at: null,
          valid_at: existingTime.toISOString(),
          invalid_at: null
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-3',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: incomingTime,
      source: 'text',
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: incomingTime,
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-alice',
          name: 'Alice',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        },
        {
          uuid: 'new-bob',
          name: 'Bob',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [
        {
          uuid: 'new-edge',
          group_id: 'group',
          source_node_uuid: 'new-alice',
          target_node_uuid: 'new-bob',
          created_at: incomingTime,
          valid_at: incomingTime,
          name: 'knows',
          fact: 'Alice knows Bob',
          episodes: ['episode-3']
        }
      ] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entity_edges).toHaveLength(1);
    expect(resolved.entity_edges[0]?.uuid).toBe('new-edge');
    expect(resolved.entity_edges[0]?.fact).toBe('Alice knows Bob');
    expect(resolved.invalidated_edges).toHaveLength(1);
    expect(resolved.invalidated_edges[0]?.uuid).toBe('edge-1');
    expect(resolved.invalidated_edges[0]?.invalid_at).toBeInstanceOf(Date);
    expect(resolved.invalidated_edges[0]?.expired_at).toBeInstanceOf(Date);
    expect(resolved.entity_edges[0]?.valid_at).toBeInstanceOf(Date);
  });

  test('resolves approximate names against existing group entities', async () => {
    const driver = new FakeResolutionDriver({
      existingEntities: [
        {
          uuid: 'entity-1',
          name: 'Alice Johnson',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {}
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-4',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: utcNow(),
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-alice',
          name: 'Alice',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entities.map((entity) => entity.uuid)).toEqual(['entity-1']);
    expect(resolved.entities[0]?.name).toBe('Alice Johnson');
  });

  test('resolves semantic entity and edge matches when embeddings are present', async () => {
    const driver = new FakeResolutionDriver({
      existingEntities: [
        {
          uuid: 'entity-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: [1, 0],
          summary: 'existing alice',
          attributes: {}
        },
        {
          uuid: 'entity-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: [0, 1],
          summary: 'existing bob',
          attributes: {}
        }
      ],
      existingEdges: [
        {
          uuid: 'edge-1',
          group_id: 'group',
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: utcNow().toISOString(),
          name: 'admires',
          fact: 'Alice admires Bob deeply',
          fact_embedding: [0.98, 0.02],
          episodes: ['episode-1'],
          expired_at: null,
          valid_at: null,
          invalid_at: null
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-5',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Alicia admires Roberto',
      valid_at: utcNow(),
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-alicia',
          name: 'Alicia',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          name_embedding: [1, 0],
          summary: ''
        },
        {
          uuid: 'new-roberto',
          name: 'Roberto',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          name_embedding: [0, 1],
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [
        {
          uuid: 'new-edge',
          group_id: 'group',
          source_node_uuid: 'new-alicia',
          target_node_uuid: 'new-roberto',
          created_at: utcNow(),
          name: 'admires',
          fact: 'Alicia admires Roberto',
          fact_embedding: [1, 0],
          episodes: ['episode-5']
        }
      ] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entities.map((entity) => entity.uuid)).toEqual(['entity-1', 'entity-2']);
    expect(resolved.entity_edges).toHaveLength(1);
    expect(resolved.entity_edges[0]?.uuid).toBe('edge-1');
    expect(resolved.entity_edges[0]?.episodes).toEqual(['episode-1', 'episode-5']);
    expect(resolved.invalidated_edges).toHaveLength(0);
  });

  test('resolves common aliases against existing group entities', async () => {
    const driver = new FakeResolutionDriver({
      existingEntities: [
        {
          uuid: 'entity-1',
          name: 'Robert Smith',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing robert',
          attributes: {}
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-6',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Bob Smith arrived',
      valid_at: utcNow(),
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-bob',
          name: 'Bob Smith',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entities.map((entity) => entity.uuid)).toEqual(['entity-1']);
    expect(resolved.entities[0]?.name).toBe('Robert Smith');
  });

  test('resolves entities using stored alias attributes', async () => {
    const driver = new FakeResolutionDriver({
      existingEntities: [
        {
          uuid: 'entity-1',
          name: 'Alexander Johnson',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alexander',
          attributes: {
            aliases: ['Ace Johnson']
          }
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-6b',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Ace Johnson arrived',
      valid_at: utcNow(),
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-ace',
          name: 'Ace Johnson',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entities.map((entity) => entity.uuid)).toEqual(['entity-1']);
    expect(resolved.entities[0]?.name).toBe('Alexander Johnson');
  });

  test('uses relationship context to disambiguate ambiguous entity candidates', async () => {
    const driver = new FakeResolutionDriver({
      existingEntities: [
        {
          uuid: 'entity-alice-1',
          name: 'Alex',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'works with Bob',
          attributes: {}
        },
        {
          uuid: 'entity-alice-2',
          name: 'Alex',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'works with Carol',
          attributes: {}
        },
        {
          uuid: 'entity-bob',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ],
      existingEdges: [],
      relationships: [
        {
          source_uuid: 'entity-alice-2',
          source_name: 'Alex',
          target_uuid: 'entity-bob',
          target_name: 'Bob',
          name: 'knows'
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-6c',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Alex knows Bob',
      valid_at: utcNow(),
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-alex',
          name: 'Alex',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        },
        {
          uuid: 'new-bob',
          name: 'Bob',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [
        {
          uuid: 'new-edge',
          group_id: 'group',
          source_node_uuid: 'new-alex',
          target_node_uuid: 'new-bob',
          created_at: utcNow(),
          name: 'knows',
          fact: 'Alex knows Bob',
          episodes: ['episode-6c']
        }
      ] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entities.map((entity) => entity.uuid)).toEqual(['entity-alice-2', 'entity-bob']);
  });

  test('invalidates multiple active conflicting edges for newer evidence', async () => {
    const eventTime = new Date('2026-03-30T12:00:00.000Z');
    const driver = new FakeResolutionDriver({
      existingEdges: [
        {
          uuid: 'edge-1',
          group_id: 'group',
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: '2026-03-29T00:00:00.000Z',
          name: 'knows',
          fact: 'Alice distrusts Bob',
          fact_embedding: null,
          episodes: ['episode-1'],
          expired_at: null,
          valid_at: '2026-03-29T00:00:00.000Z',
          invalid_at: null
        },
        {
          uuid: 'edge-2',
          group_id: 'group',
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: '2026-03-30T08:00:00.000Z',
          name: 'knows',
          fact: 'Alice avoids Bob',
          fact_embedding: null,
          episodes: ['episode-2'],
          expired_at: null,
          valid_at: '2026-03-30T08:00:00.000Z',
          invalid_at: null
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-7',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: eventTime,
      source: 'text',
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: eventTime,
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-alice',
          name: 'Alice',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        },
        {
          uuid: 'new-bob',
          name: 'Bob',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [
        {
          uuid: 'new-edge',
          group_id: 'group',
          source_node_uuid: 'new-alice',
          target_node_uuid: 'new-bob',
          created_at: eventTime,
          valid_at: eventTime,
          name: 'knows',
          fact: 'Alice knows Bob',
          episodes: ['episode-7']
        }
      ] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.entity_edges).toHaveLength(1);
    expect(resolved.entity_edges[0]?.uuid).toBe('new-edge');
    expect(resolved.invalidated_edges.map((edge) => edge.uuid)).toEqual(['edge-2', 'edge-1']);
    expect(resolved.invalidated_edges.every((edge) => edge.invalid_at?.toISOString() === eventTime.toISOString())).toBeTrue();
  });

  test('keeps newer conflicting facts active when ingesting older evidence', async () => {
    const olderTime = new Date('2026-03-29T12:00:00.000Z');
    const newerTime = new Date('2026-03-30T12:00:00.000Z');
    const driver = new FakeResolutionDriver({
      existingEdges: [
        {
          uuid: 'edge-future',
          group_id: 'group',
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: newerTime.toISOString(),
          name: 'knows',
          fact: 'Alice distrusts Bob',
          fact_embedding: null,
          episodes: ['episode-future'],
          expired_at: null,
          valid_at: newerTime.toISOString(),
          invalid_at: null
        }
      ]
    });
    const episode: EpisodicNode = {
      uuid: 'episode-8',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: olderTime,
      source: 'text',
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: olderTime,
      entity_edges: []
    };
    const extraction = {
      entities: [
        {
          uuid: 'new-alice',
          name: 'Alice',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        },
        {
          uuid: 'new-bob',
          name: 'Bob',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ] satisfies EntityNode[],
      entity_edges: [
        {
          uuid: 'historical-edge',
          group_id: 'group',
          source_node_uuid: 'new-alice',
          target_node_uuid: 'new-bob',
          created_at: olderTime,
          valid_at: olderTime,
          name: 'knows',
          fact: 'Alice knows Bob',
          episodes: ['episode-8']
        }
      ] satisfies EntityEdge[]
    };

    const resolved = await resolveEpisodeExtraction(driver, episode, extraction);

    expect(resolved.invalidated_edges).toHaveLength(0);
    expect(resolved.entity_edges).toHaveLength(1);
    expect(resolved.entity_edges[0]?.uuid).toBe('historical-edge');
    expect(resolved.entity_edges[0]?.valid_at?.toISOString()).toBe(olderTime.toISOString());
    expect(resolved.entity_edges[0]?.invalid_at?.toISOString()).toBe(newerTime.toISOString());
    expect(resolved.entity_edges[0]?.expired_at?.toISOString()).toBe(newerTime.toISOString());
  });
});

class FakeResolutionDriver implements GraphDriver {
  readonly provider = 'neo4j';
  readonly default_group_id = '';
  readonly database = 'neo4j';

  constructor(
    private readonly options: {
      edgeFact?: string;
      existingEntities?: Record<string, unknown>[];
      existingEdges?: Record<string, unknown>[];
      relationships?: Record<string, unknown>[];
    } = {}
  ) {}

  async executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options?: QueryOptions
  ): Promise<QueryResult<RecordShape>> {
    if (
      cypherQuery.includes('MATCH (n:Entity)') &&
      cypherQuery.includes('WHERE n.group_id = $group_id') &&
      !cypherQuery.includes('UNWIND $edge_keys AS edge_key')
    ) {
      return {
        records: (this.options.existingEntities ??
          [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'existing alice',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'existing bob',
            attributes: {}
          } as RecordShape
        ]) as RecordShape[]
      };
    }

    if (cypherQuery.includes('UNWIND $edge_keys AS edge_key')) {
      return {
        records: (this.options.existingEdges ??
          [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: this.options.edgeFact ?? 'Alice knows Bob',
            fact_embedding: null,
            episodes: ['episode-1'],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ]) as RecordShape[]
      };
    }

    if (
      cypherQuery.includes('MATCH (source:Entity)-[e:RELATES_TO]->(target:Entity)') &&
      cypherQuery.includes('source.uuid AS source_uuid')
    ) {
      return {
        records: (this.options.relationships ?? []) as RecordShape[]
      };
    }

    return { records: [] };
  }

  session(): GraphDriverSession {
    throw new Error('not used');
  }

  transaction(): AsyncDisposableTransaction {
    return new FakeTransaction();
  }

  async close(): Promise<void> {}
  async deleteAllIndexes(): Promise<void> {}
  async buildIndicesAndConstraints(): Promise<void> {}
}

class FakeTransaction implements AsyncDisposableTransaction {
  async run<RecordShape = unknown>(): Promise<QueryResult<RecordShape>> {
    return { records: [] };
  }

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}
}
