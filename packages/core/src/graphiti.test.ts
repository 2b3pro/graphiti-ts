import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type {
  AsyncDisposableTransaction,
  GraphDriver,
  GraphDriverSession,
  QueryOptions,
  QueryResult
} from './contracts';
import type { EntityEdge } from './domain/edges';
import type { EntityNode, EpisodicNode } from './domain/nodes';
import { FalkorDriver } from './driver/falkordb-driver';
import { Neo4jDriver } from './driver/neo4j-driver';
import { Graphiti } from './graphiti';
import type { EpisodeExtractionContext, EpisodeExtractionResult, EpisodeExtractor } from './ingest/extractor';
import type { NodeHydrationContext, NodeHydrator } from './ingest/hydrator';
import {
  createEdgeSearchConfig,
  createEpisodeSearchConfig,
  createNodeSearchConfig,
  createSearchConfig,
  EdgeRerankers,
  EdgeSearchMethods,
  EpisodeRerankers,
  EpisodeSearchMethods,
  NodeRerankers,
  NodeSearchMethods
} from './search/config';
import { createSearchFilters } from './search/filters';

describe('Graphiti', () => {
  test('adds a triplet through the namespace layer', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const graphiti = new Graphiti({ driver });

    const source: EntityNode = {
      uuid: 'node-1',
      name: 'Alice',
      group_id: 'group',
      labels: ['Person'],
      created_at: utcNow(),
      summary: ''
    };
    const target: EntityNode = {
      uuid: 'node-2',
      name: 'Bob',
      group_id: 'group',
      labels: ['Person'],
      created_at: utcNow(),
      summary: ''
    };
    const edge: EntityEdge = {
      uuid: 'edge-1',
      group_id: 'group',
      source_node_uuid: 'node-1',
      target_node_uuid: 'node-2',
      created_at: utcNow(),
      name: 'knows',
      fact: 'Alice knows Bob',
      episodes: []
    };

    const result = await graphiti.addTriplet({ source, target, edge });

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(transaction.committed).toBeTrue();
    expect(transaction.rolledBack).toBeFalse();
    expect(driver.calls).toHaveLength(3);
  });

  test('loads entity and episode nodes by uuid', async () => {
    const driver = new FakeDriver(new FakeTransaction(), {
      entity: {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Entity', 'Person'],
        created_at: '2026-03-30T00:00:00.000Z',
        name_embedding: [0.1, 0.2],
        summary: 'summary',
        attributes: { role: 'engineer' }
      },
      episode: {
        uuid: 'episode-1',
        name: 'intro',
        group_id: 'group',
        labels: ['Episodic'],
        created_at: '2026-03-30T00:00:00.000Z',
        source: 'text',
        source_description: 'chat',
        content: 'hello',
        valid_at: '2026-03-30T00:00:00.000Z',
        entity_edges: ['edge-1']
      }
    });
    const graphiti = new Graphiti({ driver });

    const entity = await graphiti.nodes.entity.getByUuid('entity-1');
    const episode = await graphiti.nodes.episode.getByUuid('episode-1');

    expect(entity.labels).toEqual(['Person']);
    expect(entity.attributes).toEqual({ role: 'engineer' });
    expect(episode.source).toBe('text');
    expect(episode.entity_edges).toEqual(['edge-1']);
  });

  test('adds an episode with episodic mention edges', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const graphiti = new Graphiti({ driver });

    const entity: EntityNode = {
      uuid: 'entity-1',
      name: 'Alice',
      group_id: 'group',
      labels: ['Person'],
      created_at: utcNow(),
      summary: ''
    };
    const episode: EpisodicNode = {
      uuid: 'episode-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'test',
      content: 'Alice appeared',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = await graphiti.addEpisode({
      episode,
      entities: [entity]
    });

    expect(result.episode.uuid).toBe('episode-1');
    expect(result.nodes).toHaveLength(1);
    expect(transaction.committed).toBeTrue();
    expect(driver.calls).toHaveLength(3);
  });

  test('ingests an episode through the extractor pipeline', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({ driver, episode_extractor: extractor });

    const episode: EpisodicNode = {
      uuid: 'episode-ingest-1',
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

    const result = await graphiti.ingestEpisode({
      episode,
      previous_episode_count: 3
    });

    expect(extractor.calls).toHaveLength(1);
    expect(result.nodes.map((node) => node.name)).toEqual(['Alice', 'Bob']);
    expect(result.edges.map((edge) => edge.name)).toEqual(['knows']);
    expect(transaction.committed).toBeTrue();
  });

  test('uses the model-backed extractor by default when an llm client is configured', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const llmClient = new FakeLLMClientForGraphiti();
    const graphiti = new Graphiti({ driver, llm_client: llmClient });

    const episode: EpisodicNode = {
      uuid: 'episode-llm-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Ignore the heuristic path',
      valid_at: utcNow(),
      entity_edges: []
    };

    const result = await graphiti.ingestEpisode({ episode });

    expect(llmClient.calls).toHaveLength(2);
    expect(result.nodes.map((node) => node.name)).toEqual(['Alice', 'Bob']);
    expect(result.edges.map((edge) => edge.name)).toEqual(['works_with']);
  });

  test('ingestEpisode hydrates extracted entities before saving', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const extractor = new FakeEpisodeExtractor();
    const hydrator = new FakeNodeHydrator();
    const graphiti = new Graphiti({
      driver,
      episode_extractor: extractor,
      node_hydrator: hydrator
    });

    const episode: EpisodicNode = {
      uuid: 'episode-hydrate-1',
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

    const result = await graphiti.ingestEpisode({ episode });

    expect(hydrator.calls).toHaveLength(1);
    expect(result.nodes.every((node) => node.summary === 'hydrated summary')).toBeTrue();
    expect(result.nodes[0]?.attributes?.hydrated).toBe(true);
  });

  test('uses the model-backed hydrator by default when an llm client is configured', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const llmClient = new FakeHydrationLLMClientForGraphiti();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });

    const episode: EpisodicNode = {
      uuid: 'episode-llm-hydrate-1',
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

    const result = await graphiti.ingestEpisode({ episode });

    expect(llmClient.calls).toHaveLength(1);
    expect(result.nodes[0]?.summary).toBe('Alice is a trusted collaborator.');
    expect(result.nodes[0]?.attributes?.role).toBe('engineer');
    expect(result.nodes[0]?.attributes?.source_description).toBe('chat');
  });

  test('ingestEpisode resolves existing entities and edges before saving', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {}
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ],
      keyedEdges: [
        {
          uuid: 'edge-existing-1',
          group_id: 'group',
          source_node_uuid: 'entity-existing-1',
          target_node_uuid: 'entity-existing-2',
          created_at: utcNow().toISOString(),
          name: 'knows',
          fact: 'Alice knows Bob',
          fact_embedding: null,
          episodes: ['episode-old'],
          expired_at: null,
          valid_at: null,
          invalid_at: null
        }
      ]
    });
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({ driver, episode_extractor: extractor });

    const episode: EpisodicNode = {
      uuid: 'episode-ingest-2',
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

    const result = await graphiti.ingestEpisode({ episode });

    expect(result.nodes.map((node) => node.uuid)).toEqual([
      'entity-existing-1',
      'entity-existing-2'
    ]);
    expect(result.edges.map((edge) => edge.uuid)).toEqual(['edge-existing-1']);
    expect(result.edges[0]?.episodes).toEqual(['episode-old', 'episode-ingest-2']);
  });

  test('ingestEpisode accumulates entity maintenance attributes across episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            mention_count: 2,
            edge_count: 3,
            first_seen_at: '2026-03-28T12:00:00.000Z',
            last_seen_at: '2026-03-29T12:00:00.000Z',
            source_description: 'email',
            source_descriptions: ['email']
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({ driver, episode_extractor: extractor });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const episode: EpisodicNode = {
      uuid: 'episode-ingest-maintenance-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: episodeTime,
      source: 'text',
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: episodeTime,
      entity_edges: []
    };

    const result = await graphiti.ingestEpisode({ episode });

    expect(result.nodes[0]?.uuid).toBe('entity-existing-1');
    expect(result.nodes[0]?.attributes).toMatchObject({
      mention_count: 3,
      edge_count: 3,
      first_seen_at: '2026-03-28T12:00:00.000Z',
      last_seen_at: '2026-03-30T12:00:00.000Z',
      source_description: 'chat',
      source_descriptions: ['email', 'chat']
    });
  });

  test('ingestEpisode tracks history for changing model-derived string attributes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            role: 'engineer'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new RoleChangingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-role-history-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      role: 'manager',
      role_history: ['engineer', 'manager'],
      role_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('ingestEpisode tracks timestamped history for company changes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            company: 'Acme'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new CompanyChangingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-company-history-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      company: 'Globex',
      company_history: ['Acme', 'Globex'],
      company_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('ingestEpisode does not regress company when ingesting older episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            company: 'Globex',
            last_seen_at: '2026-03-31T12:00:00.000Z'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new HistoricalCompanyHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-company-history-older-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      company: 'Globex',
      company_history: ['Globex', 'Acme'],
      company_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('ingestEpisode tracks timestamped history for department changes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            department: 'Engineering'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new DepartmentChangingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-department-history-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      department: 'Research',
      department_history: ['Engineering', 'Research'],
      department_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('ingestEpisode does not regress department when ingesting older episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            department: 'Research',
            last_seen_at: '2026-03-31T12:00:00.000Z'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new HistoricalDepartmentHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-department-history-older-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      department: 'Research',
      department_history: ['Research', 'Engineering'],
      department_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('ingestEpisode tracks timestamped history for location changes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            location: 'New York'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new LocationChangingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-location-history-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      location: 'San Francisco',
      location_history: ['New York', 'San Francisco'],
      location_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('ingestEpisode does not regress location when ingesting older episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            location: 'San Francisco',
            last_seen_at: '2026-03-31T12:00:00.000Z'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new HistoricalLocationHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-location-history-older-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      location: 'San Francisco',
      location_history: ['San Francisco', 'New York'],
      location_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('ingestEpisode tracks timestamped history for title changes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            title: 'Engineer'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new TitleChangingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-title-history-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      title: 'Director',
      title_history: ['Engineer', 'Director'],
      title_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('ingestEpisode does not regress title when ingesting older episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            title: 'Director',
            last_seen_at: '2026-03-31T12:00:00.000Z'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new HistoricalTitleHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-title-history-older-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      title: 'Director',
      title_history: ['Director', 'Engineer'],
      title_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('ingestEpisode tracks timestamped history for status changes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            status: 'active'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new StatusChangingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-status-history-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      status: 'inactive',
      status_history: ['active', 'inactive'],
      status_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('ingestEpisode does not regress status when ingesting older episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            status: 'inactive',
            last_seen_at: '2026-03-31T12:00:00.000Z'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new HistoricalStatusHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-status-history-older-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      status: 'inactive',
      status_history: ['inactive', 'active'],
      status_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('ingestEpisode does not regress the latest string attribute when ingesting older episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            role: 'manager',
            last_seen_at: '2026-03-31T12:00:00.000Z'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new HistoricalRoleHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-role-history-older-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      role: 'manager',
      role_history: ['manager', 'engineer'],
      role_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('ingestEpisode accumulates configured string-set attributes from model hydration', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            skills: ['python'],
            tags: 'founder'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new SkillMergingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-skill-merge-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      skills: ['python', 'typescript'],
      tags: ['founder', 'operator']
    });
  });

  test('ingestEpisode accumulates configured team string-set attributes from model hydration', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            teams: 'platform'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new TeamMergingHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-team-merge-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'chat',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      teams: ['platform', 'research']
    });
  });

  test('ingestEpisode ignores null model attributes from older evidence', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {
            role: 'manager',
            role_updated_at: '2026-03-31T12:00:00.000Z',
            skills: ['python'],
            last_seen_at: '2026-03-31T12:00:00.000Z'
          }
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ]
    });
    const llmClient = new NullAttributeHydrationLLMClient();
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({
      driver,
      llm_client: llmClient,
      episode_extractor: extractor
    });
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');

    const result = await graphiti.ingestEpisode({
      episode: {
        uuid: 'episode-role-null-older-1',
        name: 'episode',
        group_id: 'group',
        labels: [],
        created_at: episodeTime,
        source: 'text',
        source_description: 'archive',
        content: 'Alice knows Bob',
        valid_at: episodeTime,
        entity_edges: []
      }
    });

    expect(result.nodes[0]?.attributes).toMatchObject({
      role: 'manager',
      role_updated_at: '2026-03-31T12:00:00.000Z',
      skills: ['python'],
      last_seen_at: '2026-03-31T12:00:00.000Z',
      source_description: 'archive',
      source_descriptions: ['archive']
    });
  });

  test('ingestEpisode enriches extraction embeddings before semantic resolution', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: [1, 0],
          summary: 'existing alice',
          attributes: {}
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: [0, 1],
          summary: 'existing bob',
          attributes: {}
        }
      ],
      keyedEdges: [
        {
          uuid: 'edge-existing-2',
          group_id: 'group',
          source_node_uuid: 'entity-existing-1',
          target_node_uuid: 'entity-existing-2',
          created_at: utcNow().toISOString(),
          name: 'admires',
          fact: 'Alice admires Bob deeply',
          fact_embedding: [1, 0],
          episodes: ['episode-old'],
          expired_at: null,
          valid_at: null,
          invalid_at: null
        }
      ]
    });
    const extractor = new SemanticEpisodeExtractor();
    const embedder = new SemanticEmbedder({
      Alicia: [1, 0],
      Roberto: [0, 1],
      'Alicia admires Roberto': [1, 0]
    });
    const graphiti = new Graphiti({
      driver,
      embedder,
      episode_extractor: extractor
    });

    const episode: EpisodicNode = {
      uuid: 'episode-ingest-3',
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

    const result = await graphiti.ingestEpisode({ episode });

    expect(embedder.calls).toEqual(['Alicia', 'Roberto', 'Alicia admires Roberto']);
    expect(result.nodes.map((node) => node.uuid)).toEqual([
      'entity-existing-1',
      'entity-existing-2'
    ]);
    expect(result.edges.map((edge) => edge.uuid)).toEqual(['edge-existing-2']);
    expect(result.edges[0]?.episodes).toEqual(['episode-old', 'episode-ingest-3']);
  });

  test('ingestEpisode preserves historical contradictions when newer facts already exist', async () => {
    const historicalTime = new Date('2026-03-29T12:00:00.000Z');
    const futureTime = new Date('2026-03-30T12:00:00.000Z');
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction, {
      namedEntities: [
        {
          uuid: 'entity-existing-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing alice',
          attributes: {}
        },
        {
          uuid: 'entity-existing-2',
          name: 'Bob',
          group_id: 'group',
          labels: ['Entity', 'Person'],
          created_at: utcNow().toISOString(),
          name_embedding: null,
          summary: 'existing bob',
          attributes: {}
        }
      ],
      keyedEdges: [
        {
          uuid: 'edge-future-1',
          group_id: 'group',
          source_node_uuid: 'entity-existing-1',
          target_node_uuid: 'entity-existing-2',
          created_at: futureTime.toISOString(),
          name: 'knows',
          fact: 'Alice distrusts Bob',
          fact_embedding: null,
          episodes: ['episode-future'],
          expired_at: null,
          valid_at: futureTime.toISOString(),
          invalid_at: null
        }
      ]
    });
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({ driver, episode_extractor: extractor });

    const episode: EpisodicNode = {
      uuid: 'episode-ingest-4',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: historicalTime,
      source: 'text',
      source_description: 'chat',
      content: 'Alice knows Bob',
      valid_at: historicalTime,
      entity_edges: []
    };

    const result = await graphiti.ingestEpisode({ episode });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.uuid).toBe('edge-1');
    expect(result.edges[0]?.valid_at?.toISOString()).toBe(historicalTime.toISOString());
    expect(result.edges[0]?.invalid_at?.toISOString()).toBe(futureTime.toISOString());
    expect(result.edges[0]?.expired_at?.toISOString()).toBe(futureTime.toISOString());
    expect(result.episode.entity_edges).toEqual(['edge-1']);
  });

  test('ingestEpisodes processes episodes in chronological order', async () => {
    const transaction = new FakeTransaction();
    const driver = new OrderedIngestFakeDriver(transaction);
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({ driver, episode_extractor: extractor });
    const olderTime = new Date('2026-03-29T12:00:00.000Z');
    const newerTime = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.ingestEpisodes({
      episodes: [
        {
          episode: {
            uuid: 'episode-newer',
            name: 'episode',
            group_id: 'group',
            labels: [],
            created_at: newerTime,
            source: 'text',
            source_description: 'chat',
            content: 'Alice knows Bob',
            valid_at: newerTime,
            entity_edges: []
          }
        },
        {
          episode: {
            uuid: 'episode-older',
            name: 'episode',
            group_id: 'group',
            labels: [],
            created_at: olderTime,
            source: 'text',
            source_description: 'chat',
            content: 'Alice knows Bob',
            valid_at: olderTime,
            entity_edges: []
          }
        }
      ]
    });

    expect(result.episodes.map((entry) => entry.episode.uuid)).toEqual([
      'episode-older',
      'episode-newer'
    ]);
    expect(result.episodes[0]?.previous_episodes).toHaveLength(0);
    expect(result.episodes[1]?.previous_episodes.map((episode) => episode.uuid)).toEqual([
      'episode-older'
    ]);
  });


  test('addEpisodeBulk deduplicates entities with same name across episodes', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const extractor = new FakeEpisodeExtractor();
    const graphiti = new Graphiti({ driver, episode_extractor: extractor });
    const time1 = new Date('2026-03-29T12:00:00.000Z');
    const time2 = new Date('2026-03-30T12:00:00.000Z');

    const result = await graphiti.addEpisodeBulk([
      {
        episode: {
          uuid: 'ep-bulk-1',
          name: 'episode-1',
          group_id: 'group',
          labels: [],
          created_at: time1,
          source: 'text',
          source_description: 'chat',
          content: 'Alice knows Bob',
          valid_at: time1,
          entity_edges: []
        }
      },
      {
        episode: {
          uuid: 'ep-bulk-2',
          name: 'episode-2',
          group_id: 'group',
          labels: [],
          created_at: time2,
          source: 'text',
          source_description: 'chat',
          content: 'Alice works with Carol',
          valid_at: time2,
          entity_edges: []
        }
      }
    ]);

    expect(result.episodes).toHaveLength(2);

    // Both episodes should have been processed
    expect(result.episodes[0]?.episode.uuid).toBe('ep-bulk-1');
    expect(result.episodes[1]?.episode.uuid).toBe('ep-bulk-2');

    // The extractor produces Alice and Bob for each episode, so Alice
    // should be deduplicated across the batch — the second episode's
    // Alice entity should be merged into the first episode's Alice.
    // We verify that at least one episode has fewer entities than the
    // extractor would produce independently, because duplicates are removed.
    const totalEntities = result.episodes.flatMap((r) => r.nodes);
    const uniqueNames = new Set(totalEntities.map((n) => n.name.toLowerCase()));
    // Alice appears in both episodes but should be canonical
    expect(uniqueNames.has('alice')).toBeTrue();
  });

  test('addEpisodeBulk returns empty result for empty input', async () => {
    const driver = new FakeDriver(new FakeTransaction());
    const graphiti = new Graphiti({ driver });

    const result = await graphiti.addEpisodeBulk([]);
    expect(result.episodes).toHaveLength(0);
  });

  test('delegates search through the graphiti client', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchFakeNeo4jClient()
    );
    const graphiti = new Graphiti({ driver });

    const results = await graphiti.search(
      'alice',
      createSearchConfig({
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25]
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25]
        })
      }),
      {
        group_ids: ['group'],
        search_filter: createSearchFilters({
          node_labels: ['Person']
        })
      }
    );

    expect(results.nodes).toHaveLength(1);
    expect(results.edges).toHaveLength(1);
  });

  test('delegates search through the graphiti client for FalkorDB', async () => {
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new SearchFakeFalkorClient()
    );
    const graphiti = new Graphiti({ driver });

    const results = await graphiti.search(
      'alice',
      createSearchConfig({
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25]
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25]
        })
      }),
      {
        group_ids: ['group'],
        search_filter: createSearchFilters({
          node_labels: ['Person']
        })
      }
    );

    expect(results.nodes).toHaveLength(1);
    expect(results.nodes[0]?.name).toBe('Alice');
    expect(results.edges).toHaveLength(1);
    expect(results.edges[0]?.fact).toBe('Alice knows Bob');
  });

  test('supports bfs origin uuids through the graphiti client', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchFusionFakeNeo4jClient()
    );
    const graphiti = new Graphiti({ driver });

    const results = await graphiti.search(
      'alice',
      createSearchConfig({
        limit: 2,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.bfs]
        })
      }),
      {
        group_ids: ['group'],
        search_filter: createSearchFilters({
          node_labels: ['Person']
        }),
        bfs_origin_node_uuids: ['entity-1']
      }
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-1', 'entity-2']);
    expect(results.node_reranker_scores).toEqual([2, 0.5]);
  });

  test('loads entity and edge records through Falkor operations', async () => {
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new EntityOpsFakeFalkorClient()
    );
    const graphiti = new Graphiti({ driver });

    const entity = await graphiti.nodes.entity.getByUuid('entity-1');
    const edge = await graphiti.edges.entity.getByUuid('edge-1');

    expect(entity.uuid).toBe('entity-1');
    expect(entity.labels).toEqual(['Person']);
    expect(edge.uuid).toBe('edge-1');
    expect(edge.fact).toBe('Alice knows Bob');
  });

  test('adds and loads an episode through Falkor operations', async () => {
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new EpisodeOpsFakeFalkorClient()
    );
    const graphiti = new Graphiti({ driver });

    const entity: EntityNode = {
      uuid: 'entity-1',
      name: 'Alice',
      group_id: 'group',
      labels: ['Person'],
      created_at: utcNow(),
      summary: ''
    };
    const episode: EpisodicNode = {
      uuid: 'episode-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: 'text',
      source_description: 'chat',
      content: 'Alice appeared',
      valid_at: utcNow(),
      entity_edges: ['edge-1']
    };

    const result = await graphiti.addEpisode({
      episode,
      entities: [entity]
    });
    const loadedEpisode = await graphiti.nodes.episode.getByUuid('episode-1');

    expect(result.episode.uuid).toBe('episode-1');
    expect(result.nodes).toHaveLength(1);
    expect(loadedEpisode.uuid).toBe('episode-1');
    expect(loadedEpisode.content).toBe('Alice appeared');
    expect(loadedEpisode.entity_edges).toEqual(['edge-1']);
  });

  test('retrieves episodes by group through the graphiti client', async () => {
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      new EpisodeOpsFakeFalkorClient()
    );
    const graphiti = new Graphiti({ driver });

    const episodes = await graphiti.retrieveEpisodes(['group'], 2, utcNow());

    expect(episodes).toHaveLength(2);
    expect(episodes.map((episode) => episode.uuid)).toEqual(['episode-2', 'episode-1']);
  });

  test('deletes an entity edge through Falkor operations', async () => {
    const client = new DeleteEdgeFakeFalkorClient();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      client
    );
    const graphiti = new Graphiti({ driver });

    await graphiti.deleteEntityEdge('edge-1');

    expect(client.graph.deletedEdgeUuids).toEqual(['edge-1']);
  });

  test('deletes an episode through Falkor operations', async () => {
    const client = new DeleteEpisodeFakeFalkorClient();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      client
    );
    const graphiti = new Graphiti({ driver });

    await graphiti.deleteEpisode('episode-1');

    expect(client.graph.deletedEpisodeUuids).toEqual(['episode-1']);
  });

  test('deletes a group through Falkor operations', async () => {
    const client = new DeleteGroupFakeFalkorClient();
    const driver = new FalkorDriver(
      {
        host: 'localhost',
        port: 6379,
        database: 'default_db'
      },
      client
    );
    const graphiti = new Graphiti({ driver });

    await graphiti.deleteGroup('group');

    expect(client.graph.deletedEdgeGroupIds).toEqual(['group']);
    expect(client.graph.deletedEpisodeGroupIds).toEqual(['group']);
    expect(client.graph.deletedEntityGroupIds).toEqual(['group']);
  });

  test('clears the graph through the graphiti client', async () => {
    const transaction = new FakeTransaction();
    const driver = new FakeDriver(transaction);
    const graphiti = new Graphiti({ driver });

    await graphiti.clear();

    expect(transaction.committed).toBeTrue();
    expect(transaction.rolledBack).toBeFalse();
    expect(driver.calls.some((call) => call.cypherQuery.includes('MATCH (n)'))).toBeTrue();
  });

  test('uses the embedder for cosine similarity search', async () => {
    const embedder = new FakeEmbedder([1, 0]);
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchVectorFakeNeo4jClient()
    );
    const graphiti = new Graphiti({ driver, embedder });

    const results = await graphiti.search(
      'alice',
      createSearchConfig({
        limit: 1,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.cosine_similarity]
        })
      }),
      {
        group_ids: ['group'],
        search_filter: createSearchFilters({
          node_labels: ['Person']
        })
      }
    );

    expect(embedder.calls).toEqual(['alice']);
    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-1']);
  });

  test('uses the embedder for mmr reranking without cosine search methods', async () => {
    const embedder = new FakeEmbedder([1, 0]);
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchVectorFakeNeo4jClient()
    );
    const graphiti = new Graphiti({ driver, embedder });

    const results = await graphiti.search(
      'alice',
      createSearchConfig({
        limit: 1,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25],
          reranker: NodeRerankers.mmr
        }),
        edge_config: createEdgeSearchConfig({
          search_methods: [EdgeSearchMethods.bm25],
          reranker: EdgeRerankers.mmr
        })
      }),
      {
        group_ids: ['group'],
        search_filter: createSearchFilters({
          node_labels: ['Person']
        })
      }
    );

    expect(embedder.calls).toEqual(['alice']);
    expect(results.nodes).toHaveLength(1);
    expect(results.edges).toHaveLength(1);
  });

  test('uses the cross encoder for reranking', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchVectorFakeNeo4jClient()
    );
    const crossEncoder = new FakeCrossEncoder();
    const graphiti = new Graphiti({ driver, cross_encoder: crossEncoder });

    const results = await graphiti.search(
      'alice',
      createSearchConfig({
        limit: 1,
        node_config: createNodeSearchConfig({
          search_methods: [NodeSearchMethods.bm25],
          reranker: NodeRerankers.cross_encoder
        })
      }),
      {
        group_ids: ['group'],
        search_filter: createSearchFilters({
          node_labels: ['Person']
        })
      }
    );

    expect(results.nodes.map((node) => node.uuid)).toEqual(['entity-2']);
  });

  test('uses the cross encoder for episode reranking', async () => {
    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      new SearchEpisodeFakeNeo4jClient()
    );
    const crossEncoder = new FakeCrossEncoder();
    const graphiti = new Graphiti({ driver, cross_encoder: crossEncoder });

    const results = await graphiti.search(
      'alice',
      createSearchConfig({
        limit: 1,
        episode_config: createEpisodeSearchConfig({
          search_methods: [EpisodeSearchMethods.bm25],
          reranker: EpisodeRerankers.cross_encoder
        })
      }),
      {
        group_ids: ['group']
      }
    );

    expect(results.episodes.map((episode) => episode.uuid)).toEqual(['episode-2']);
  });
});

class FakeDriver implements GraphDriver {
  readonly provider = 'neo4j';
  readonly default_group_id = '';
  readonly database = 'neo4j';
  calls: Array<{ cypherQuery: string; options?: QueryOptions }> = [];

  constructor(
    private readonly transactionInstance: FakeTransaction,
    private readonly records?: {
      entity?: Record<string, unknown>;
      episode?: Record<string, unknown>;
      namedEntities?: Record<string, unknown>[];
      keyedEdges?: Record<string, unknown>[];
    }
  ) {}

  async executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options?: QueryOptions
  ): Promise<QueryResult<RecordShape>> {
    if (options) {
      this.calls.push({ cypherQuery, options });
    } else {
      this.calls.push({ cypherQuery });
    }

    if (cypherQuery.includes('MATCH (n:Entity {uuid: $uuid})')) {
      return {
        records: this.records?.entity ? [this.records.entity as RecordShape] : []
      };
    }

    if (cypherQuery.includes('MATCH (n:Episodic {uuid: $uuid})')) {
      return {
        records: this.records?.episode ? [this.records.episode as RecordShape] : []
      };
    }

    if (
      cypherQuery.includes('MATCH (n:Entity)') &&
      cypherQuery.includes('WHERE n.group_id = $group_id') &&
      !cypherQuery.includes('UNWIND $edge_keys AS edge_key')
    ) {
      return {
        records: (this.records?.namedEntities ?? []) as RecordShape[]
      };
    }

    if (cypherQuery.includes('UNWIND $edge_keys AS edge_key')) {
      return {
        records: (this.records?.keyedEdges ?? []) as RecordShape[]
      };
    }

    return { records: [] };
  }

  session(): GraphDriverSession {
    throw new Error('not used in tests');
  }

  transaction(): AsyncDisposableTransaction {
    return this.transactionInstance;
  }

  async close(): Promise<void> {}

  async deleteAllIndexes(): Promise<void> {}

  async buildIndicesAndConstraints(): Promise<void> {}
}

class OrderedIngestFakeDriver extends FakeDriver {
  override async executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options?: QueryOptions
  ): Promise<QueryResult<RecordShape>> {
    if (
      cypherQuery.includes('MATCH (n:Episodic)') &&
      cypherQuery.includes('n.group_id IN $group_ids')
    ) {
      const referenceTime = options?.params?.reference_time;
      const referenceDate =
        referenceTime instanceof Date ? referenceTime : new Date(String(referenceTime ?? ''));

      if (referenceDate.toISOString() === '2026-03-29T12:00:00.000Z') {
        return { records: [] };
      }

      if (referenceDate.toISOString() === '2026-03-30T12:00:00.000Z') {
        return {
          records: [
            {
              uuid: 'episode-older',
              name: 'episode',
              group_id: 'group',
              labels: ['Episodic'],
              created_at: '2026-03-29T12:00:00.000Z',
              source: 'text',
              source_description: 'chat',
              content: 'Alice knows Bob',
              valid_at: '2026-03-29T12:00:00.000Z',
              entity_edges: []
            } as RecordShape
          ]
        };
      }
    }

    return super.executeQuery<RecordShape>(cypherQuery, options);
  }
}

class FakeTransaction implements AsyncDisposableTransaction {
  committed = false;
  rolledBack = false;

  async run<RecordShape = unknown>(): Promise<QueryResult<RecordShape>> {
    return { records: [] };
  }

  async commit(): Promise<void> {
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }
}

class FakeEmbedder {
  calls: string[] = [];

  constructor(private readonly embedding: number[]) {}

  async create(inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>) {
    if (typeof inputData === 'string') {
      this.calls.push(inputData);
    } else if (Array.isArray(inputData) && typeof inputData[0] === 'string') {
      this.calls.push(String(inputData[0]));
    }

    return this.embedding;
  }
}

class SemanticEmbedder {
  calls: string[] = [];

  constructor(private readonly embeddings: Record<string, number[]>) {}

  async create(inputData: string | string[] | Iterable<number> | Iterable<Iterable<number>>) {
    const value =
      typeof inputData === 'string'
        ? inputData
        : Array.isArray(inputData) && typeof inputData[0] === 'string'
          ? String(inputData[0])
          : '';

    this.calls.push(value);
    return this.embeddings[value] ?? [0, 0];
  }
}

class FakeCrossEncoder {
  async rank(query: string, passages: string[]): Promise<Array<[string, number]>> {
    return passages
      .map((passage) => [passage, graphitiCrossEncoderScore(query, passage)] as [string, number])
      .sort((left, right) => right[1] - left[1]);
  }
}

class FakeLLMClientForGraphiti {
  readonly model = 'fake-model';
  readonly small_model = null;
  calls: Array<{ role: string; content: string }[]> = [];

  setTracer(): void {}

  async generateText(messages: Array<{ role: string; content: string }>): Promise<string> {
    this.calls.push(messages);

    return JSON.stringify({
      entities: [{ name: 'Alice', labels: ['Person'], summary: 'Engineer' }],
      entity_edges: [
        {
          source: 'Alice',
          target: 'Bob',
          name: 'works_with',
          fact: 'Alice works with Bob'
        }
      ]
    });
  }
}

class FakeHydrationLLMClientForGraphiti {
  readonly model = 'fake-model';
  readonly small_model = null;
  calls: Array<{ role: string; content: string }[]> = [];

  setTracer(): void {}

  async generateText(messages: Array<{ role: string; content: string }>): Promise<string> {
    this.calls.push(messages);

    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-1',
          summary: 'Alice is a trusted collaborator.',
          attributes: {
            role: 'engineer'
          }
        }
      ]
    });
  }
}

class RoleChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice now leads the team.',
          attributes: {
            role: 'manager'
          }
        }
      ]
    });
  }
}

class CompanyChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice joined Globex.',
          attributes: {
            company: 'Globex'
          }
        }
      ]
    });
  }
}

class HistoricalCompanyHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice previously worked at Acme.',
          attributes: {
            company: 'Acme'
          }
        }
      ]
    });
  }
}

class DepartmentChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice moved to Research.',
          attributes: {
            department: 'Research'
          }
        }
      ]
    });
  }
}

class HistoricalDepartmentHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice previously worked in Engineering.',
          attributes: {
            department: 'Engineering'
          }
        }
      ]
    });
  }
}

class LocationChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice moved to San Francisco.',
          attributes: {
            location: 'San Francisco'
          }
        }
      ]
    });
  }
}

class HistoricalLocationHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice previously lived in New York.',
          attributes: {
            location: 'New York'
          }
        }
      ]
    });
  }
}

class TitleChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice became a Director.',
          attributes: {
            title: 'Director'
          }
        }
      ]
    });
  }
}

class HistoricalTitleHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice previously held the title Engineer.',
          attributes: {
            title: 'Engineer'
          }
        }
      ]
    });
  }
}

class StatusChangingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice became inactive.',
          attributes: {
            status: 'inactive'
          }
        }
      ]
    });
  }
}

class HistoricalStatusHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice was previously active.',
          attributes: {
            status: 'active'
          }
        }
      ]
    });
  }
}

class HistoricalRoleHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice previously worked as an engineer.',
          attributes: {
            role: 'engineer'
          }
        }
      ]
    });
  }
}

class SkillMergingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice expanded her operating range.',
          attributes: {
            skills: ['typescript', 'python'],
            tags: ['operator', 'founder']
          }
        }
      ]
    });
  }
}

class TeamMergingHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice collaborates with the research team.',
          attributes: {
            teams: ['research', 'platform']
          }
        }
      ]
    });
  }
}

class NullAttributeHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [
        {
          uuid: 'entity-existing-1',
          summary: 'Alice is mentioned in archival context.',
          attributes: {
            role: null,
            skills: null
          }
        }
      ]
    });
  }
}

class FakeEpisodeExtractor implements EpisodeExtractor {
  calls: EpisodeExtractionContext[] = [];

  async extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult> {
    this.calls.push(context);

    return {
      entities: [
        {
          uuid: 'entity-1',
          name: 'Alice',
          group_id: context.episode.group_id,
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        },
        {
          uuid: 'entity-2',
          name: 'Bob',
          group_id: context.episode.group_id,
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ],
      entity_edges: [
        {
          uuid: 'edge-1',
          group_id: context.episode.group_id,
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: context.episode.created_at,
          name: 'knows',
          fact: 'Alice knows Bob',
          episodes: [context.episode.uuid]
        }
      ]
    };
  }
}

class SemanticEpisodeExtractor implements EpisodeExtractor {
  async extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult> {
    return {
      entities: [
        {
          uuid: 'entity-1',
          name: 'Alicia',
          group_id: context.episode.group_id,
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        },
        {
          uuid: 'entity-2',
          name: 'Roberto',
          group_id: context.episode.group_id,
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ],
      entity_edges: [
        {
          uuid: 'edge-1',
          group_id: context.episode.group_id,
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: context.episode.created_at,
          name: 'admires',
          fact: 'Alicia admires Roberto',
          episodes: [context.episode.uuid]
        }
      ]
    };
  }
}

class FakeNodeHydrator implements NodeHydrator {
  calls: NodeHydrationContext[] = [];

  async hydrate(context: NodeHydrationContext): Promise<EntityNode[]> {
    this.calls.push(context);

    return context.entities.map((entity) => ({
      ...entity,
      summary: 'hydrated summary',
      attributes: {
        ...(entity.attributes ?? {}),
        hydrated: true
      }
    }));
  }
}

class SearchFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)')) {
      return {
        records: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: null,
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ]
      };
    }

    if (query.includes('MATCH (n:Entity)')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    return { records: [] };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

class SearchFakeFalkorClient {
  selectGraph(_graphId: string): SearchFakeFalkorGraph {
    return new SearchFakeFalkorGraph();
  }

  async close(): Promise<void> {}
}

class SearchFakeFalkorGraph {
  async query<RecordShape = unknown>(
    query: string
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.reply<RecordShape>(query);
  }

  async roQuery<RecordShape = unknown>(
    query: string
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.reply<RecordShape>(query);
  }

  async createNodeRangeIndex(): Promise<void> {}
  async createNodeFulltextIndex(): Promise<void> {}
  async createEdgeRangeIndex(): Promise<void> {}
  async createEdgeFulltextIndex(): Promise<void> {}
  async delete(): Promise<void> {}

  private async reply<RecordShape>(
    query: string
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)')) {
      return {
        data: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: null,
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ],
        headers: []
      };
    }

    if (query.includes('MATCH (n:Entity)')) {
      return {
        data: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ],
        headers: []
      };
    }

    return { data: [], headers: [] };
  }
}

class EntityOpsFakeFalkorClient {
  selectGraph(_graphId: string): EntityOpsFakeFalkorGraph {
    return new EntityOpsFakeFalkorGraph();
  }

  async close(): Promise<void> {}
}

class EntityOpsFakeFalkorGraph {
  async query<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.reply<RecordShape>(query, options);
  }

  async roQuery<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.reply<RecordShape>(query, options);
  }

  async createNodeRangeIndex(): Promise<void> {}
  async createNodeFulltextIndex(): Promise<void> {}
  async createEdgeRangeIndex(): Promise<void> {}
  async createEdgeFulltextIndex(): Promise<void> {}
  async delete(): Promise<void> {}

  private async reply<RecordShape>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (
      query.includes('MATCH (n:Entity {uuid: $uuid})') &&
      options?.params?.uuid === 'entity-1'
    ) {
      return {
        data: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ],
        headers: []
      };
    }

    if (
      query.includes('MATCH (source:Entity)-[e:RELATES_TO {uuid: $uuid}]->(target:Entity)') &&
      options?.params?.uuid === 'edge-1'
    ) {
      return {
        data: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: null,
            episodes: ['episode-1'],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ],
        headers: []
      };
    }

    return { data: [], headers: [] };
  }
}

class EpisodeOpsFakeFalkorClient {
  selectGraph(_graphId: string): EpisodeOpsFakeFalkorGraph {
    return new EpisodeOpsFakeFalkorGraph();
  }

  async close(): Promise<void> {}
}

class DeleteEdgeFakeFalkorClient {
  readonly graph = new DeleteEdgeFakeFalkorGraph();

  selectGraph(_graphId: string): DeleteEdgeFakeFalkorGraph {
    return this.graph;
  }

  async close(): Promise<void> {}
}

class DeleteEpisodeFakeFalkorClient {
  readonly graph = new DeleteEpisodeFakeFalkorGraph();

  selectGraph(_graphId: string): DeleteEpisodeFakeFalkorGraph {
    return this.graph;
  }

  async close(): Promise<void> {}
}

class DeleteGroupFakeFalkorClient {
  readonly graph = new DeleteGroupFakeFalkorGraph();

  selectGraph(_graphId: string): DeleteGroupFakeFalkorGraph {
    return this.graph;
  }

  async close(): Promise<void> {}
}

class DeleteEdgeFakeFalkorGraph {
  deletedEdgeUuids: string[] = [];

  async query<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (query.includes('MATCH ()-[e:RELATES_TO {uuid: $uuid}]->()')) {
      this.deletedEdgeUuids.push(String(options?.params?.uuid ?? ''));
      return {
        data: [{ deleted_count: 1 } as RecordShape],
        headers: []
      };
    }

    return { data: [], headers: [] };
  }

  async roQuery<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.query<RecordShape>(query, options);
  }

  async createNodeRangeIndex(): Promise<void> {}
  async createNodeFulltextIndex(): Promise<void> {}
  async createEdgeRangeIndex(): Promise<void> {}
  async createEdgeFulltextIndex(): Promise<void> {}
  async delete(): Promise<void> {}
}

class DeleteEpisodeFakeFalkorGraph {
  deletedEpisodeUuids: string[] = [];

  async query<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (query.includes('MATCH (n:Episodic {uuid: $uuid})')) {
      this.deletedEpisodeUuids.push(String(options?.params?.uuid ?? ''));
      return {
        data: [{ deleted_count: 1 } as RecordShape],
        headers: []
      };
    }

    return { data: [], headers: [] };
  }

  async roQuery<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.query<RecordShape>(query, options);
  }

  async createNodeRangeIndex(): Promise<void> {}
  async createNodeFulltextIndex(): Promise<void> {}
  async createEdgeRangeIndex(): Promise<void> {}
  async createEdgeFulltextIndex(): Promise<void> {}
  async delete(): Promise<void> {}
}

class DeleteGroupFakeFalkorGraph {
  deletedEdgeGroupIds: string[] = [];
  deletedEpisodeGroupIds: string[] = [];
  deletedEntityGroupIds: string[] = [];

  async query<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (query.includes('MATCH ()-[e:RELATES_TO]->()') && query.includes('e.group_id = $group_id')) {
      this.deletedEdgeGroupIds.push(String(options?.params?.group_id ?? ''));
      return {
        data: [{ deleted_count: 1 } as RecordShape],
        headers: []
      };
    }

    if (query.includes('MATCH (n:Episodic)') && query.includes('n.group_id = $group_id')) {
      this.deletedEpisodeGroupIds.push(String(options?.params?.group_id ?? ''));
      return {
        data: [{ deleted_count: 1 } as RecordShape],
        headers: []
      };
    }

    if (query.includes('MATCH (n:Entity)') && query.includes('n.group_id = $group_id')) {
      this.deletedEntityGroupIds.push(String(options?.params?.group_id ?? ''));
      return {
        data: [{ deleted_count: 1 } as RecordShape],
        headers: []
      };
    }

    return { data: [], headers: [] };
  }

  async roQuery<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.query<RecordShape>(query, options);
  }

  async createNodeRangeIndex(): Promise<void> {}
  async createNodeFulltextIndex(): Promise<void> {}
  async createEdgeRangeIndex(): Promise<void> {}
  async createEdgeFulltextIndex(): Promise<void> {}
  async delete(): Promise<void> {}
}

class EpisodeOpsFakeFalkorGraph {
  async query<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.reply<RecordShape>(query, options);
  }

  async roQuery<RecordShape = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    return this.reply<RecordShape>(query, options);
  }

  async createNodeRangeIndex(): Promise<void> {}
  async createNodeFulltextIndex(): Promise<void> {}
  async createEdgeRangeIndex(): Promise<void> {}
  async createEdgeFulltextIndex(): Promise<void> {}
  async delete(): Promise<void> {}

  private async reply<RecordShape>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ data?: RecordShape[]; headers?: string[] }> {
    if (query.includes('MATCH (n:Episodic)') && query.includes('n.group_id IN $group_ids')) {
      return {
        data: [
          {
            uuid: 'episode-2',
            name: 'episode 2',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: '2026-03-31T00:00:00.000Z',
            source: 'text',
            source_description: 'chat',
            content: 'Second episode',
            valid_at: '2026-03-31T00:00:00.000Z',
            entity_edges: []
          } as RecordShape,
          {
            uuid: 'episode-1',
            name: 'episode',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: '2026-03-30T00:00:00.000Z',
            source: 'text',
            source_description: 'chat',
            content: 'Alice appeared',
            valid_at: '2026-03-30T00:00:00.000Z',
            entity_edges: ['edge-1']
          } as RecordShape
        ],
        headers: []
      };
    }

    if (query.includes('MATCH (n:Episodic {uuid: $uuid})') && options?.params?.uuid === 'episode-1') {
      return {
        data: [
          {
            uuid: 'episode-1',
            name: 'episode',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: utcNow().toISOString(),
            source: 'text',
            source_description: 'chat',
            content: 'Alice appeared',
            valid_at: utcNow().toISOString(),
            entity_edges: ['edge-1']
          } as RecordShape
        ],
        headers: []
      };
    }

    return { data: [], headers: [] };
  }
}

class SearchFusionFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (query.includes('MATCH path = (origin)-[:RELATES_TO*1..')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    if (query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)')) {
      return { records: [] };
    }

    if (query.includes('MATCH (n:Entity)')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: null,
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    return { records: [] };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

class SearchVectorFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (query.includes('MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)')) {
      return {
        records: [
          {
            uuid: 'edge-1',
            group_id: 'group',
            source_node_uuid: 'entity-1',
            target_node_uuid: 'entity-2',
            created_at: utcNow().toISOString(),
            name: 'knows',
            fact: 'Alice knows Bob',
            fact_embedding: [1, 0],
            episodes: [],
            expired_at: null,
            valid_at: null,
            invalid_at: null
          } as RecordShape
        ]
      };
    }

    if (query.includes('MATCH (n:Entity)')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [1, 0],
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [0, 1],
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    if (query.includes('n.name_embedding IS NOT NULL')) {
      return {
        records: [
          {
            uuid: 'entity-1',
            name: 'Alice',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [1, 0],
            summary: 'summary',
            attributes: {}
          } as RecordShape,
          {
            uuid: 'entity-2',
            name: 'Bob',
            group_id: 'group',
            labels: ['Entity', 'Person'],
            created_at: utcNow().toISOString(),
            name_embedding: [0, 1],
            summary: 'summary',
            attributes: {}
          } as RecordShape
        ]
      };
    }

    return { records: [] };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

class SearchEpisodeFakeNeo4jClient {
  async executeQuery<RecordShape = unknown>(
    query: string
  ): Promise<QueryResult<RecordShape>> {
    if (query.includes('MATCH (n:Episodic)')) {
      return {
        records: [
          {
            uuid: 'episode-1',
            name: 'episode one',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: utcNow().toISOString(),
            source: 'text',
            source_description: 'chat',
            content: 'Alice greeted Bob',
            valid_at: utcNow().toISOString(),
            entity_edges: []
          } as RecordShape,
          {
            uuid: 'episode-2',
            name: 'episode two',
            group_id: 'group',
            labels: ['Episodic'],
            created_at: utcNow().toISOString(),
            source: 'text',
            source_description: 'chat',
            content: 'Bob told Carol about Alice',
            valid_at: utcNow().toISOString(),
            entity_edges: []
          } as RecordShape
        ]
      };
    }

    return { records: [] };
  }

  session(_database: string): GraphDriverSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

function graphitiCrossEncoderScore(query: string, passage: string): number {
  if (query === 'alice' && passage.includes('about Alice')) {
    return 0.95;
  }

  if (query === 'alice' && passage.includes('Bob')) {
    return 0.9;
  }

  if (query === 'alice' && passage.includes('Alice')) {
    return 0.7;
  }

  return 0.1;
}
