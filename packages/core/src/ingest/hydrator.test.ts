import { describe, expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import { EpisodeTypes } from '../domain/nodes';
import {
  buildNodeHydrationPrompt,
  HeuristicNodeHydrator,
  mapModelHydrationResponse,
  ModelNodeHydrator,
  parseModelHydrationResponse,
  splitIntoSentences
} from './hydrator';

describe('heuristic node hydrator', () => {
  test('splits content into sentences', () => {
    expect(splitIntoSentences('Alice knows Bob. Carol greeted Alice!')).toEqual([
      'Alice knows Bob.',
      'Carol greeted Alice!'
    ]);
  });

  test('hydrates summaries and attributes from episode context', async () => {
    const hydrator = new HeuristicNodeHydrator();
    const episodeTime = new Date('2026-03-30T12:00:00.000Z');
    const episode = {
      uuid: 'episode-1',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: episodeTime,
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice knows Bob. Carol greeted Alice.',
      valid_at: episodeTime,
      entity_edges: []
    };
    const entities = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: ''
      },
      {
        uuid: 'entity-2',
        name: 'Bob',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: ''
      }
    ];
    const edges = [
      {
        uuid: 'edge-1',
        group_id: 'group',
        source_node_uuid: 'entity-1',
        target_node_uuid: 'entity-2',
        created_at: utcNow(),
        name: 'knows',
        fact: 'Alice knows Bob',
        episodes: ['episode-1']
      }
    ];

    const hydrated = await hydrator.hydrate({
      episode,
      previous_episodes: [],
      entities,
      entity_edges: edges
    });

    expect(hydrated[0]?.summary).toContain('Alice knows Bob');
    expect(hydrated[0]?.attributes?.mention_count).toBe(2);
    expect(hydrated[0]?.attributes?.edge_count).toBe(1);
    expect(hydrated[0]?.attributes?.first_seen_at).toBe('2026-03-30T12:00:00.000Z');
    expect(hydrated[0]?.attributes?.last_seen_at).toBe('2026-03-30T12:00:00.000Z');
    expect(hydrated[0]?.attributes?.source_descriptions).toEqual(['chat']);
    expect(hydrated[1]?.summary).toContain('Alice knows Bob');
    expect(hydrated[1]?.attributes?.source_description).toBe('chat');
  });

  test('accumulates maintenance attributes across repeated hydration', async () => {
    const hydrator = new HeuristicNodeHydrator();
    const episodeTime = new Date('2026-03-31T12:00:00.000Z');
    const episode = {
      uuid: 'episode-2',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: episodeTime,
      source: EpisodeTypes.text,
      source_description: 'call',
      content: 'Alice briefed Bob. Alice thanked Bob.',
      valid_at: episodeTime,
      entity_edges: []
    };

    const hydrated = await hydrator.hydrate({
      episode,
      previous_episodes: [],
      entities: [
        {
          uuid: 'entity-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity'],
          created_at: utcNow(),
          summary: 'existing summary',
          attributes: {
            mention_count: 3,
            edge_count: 4,
            first_seen_at: '2026-03-28T12:00:00.000Z',
            last_seen_at: '2026-03-29T12:00:00.000Z',
            source_description: 'chat',
            source_descriptions: ['chat', 'email']
          }
        }
      ],
      entity_edges: [
        {
          uuid: 'edge-1',
          group_id: 'group',
          source_node_uuid: 'entity-1',
          target_node_uuid: 'entity-2',
          created_at: episodeTime,
          name: 'briefed',
          fact: 'Alice briefed Bob',
          episodes: ['episode-2']
        }
      ]
    });

    expect(hydrated[0]?.attributes).toMatchObject({
      mention_count: 5,
      edge_count: 4,
      first_seen_at: '2026-03-28T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z',
      source_description: 'call',
      source_descriptions: ['chat', 'email', 'call']
    });
  });

  test('does not regress latest maintenance attributes when hydrating older episodes', async () => {
    const hydrator = new HeuristicNodeHydrator();
    const episodeTime = new Date('2026-03-29T12:00:00.000Z');
    const episode = {
      uuid: 'episode-3',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: episodeTime,
      source: EpisodeTypes.text,
      source_description: 'archive',
      content: 'Alice met Bob.',
      valid_at: episodeTime,
      entity_edges: []
    };

    const hydrated = await hydrator.hydrate({
      episode,
      previous_episodes: [],
      entities: [
        {
          uuid: 'entity-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Entity'],
          created_at: utcNow(),
          summary: 'existing summary',
          attributes: {
            mention_count: 2,
            edge_count: 1,
            first_seen_at: '2026-03-28T12:00:00.000Z',
            last_seen_at: '2026-03-31T12:00:00.000Z',
            source_description: 'call',
            source_descriptions: ['call']
          }
        }
      ],
      entity_edges: []
    });

    expect(hydrated[0]?.attributes).toMatchObject({
      mention_count: 3,
      first_seen_at: '2026-03-28T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z',
      source_description: 'call',
      source_descriptions: ['call', 'archive']
    });
  });

  test('parses model hydration responses and merges them into baseline entities', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { mention_count: 1 }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            summary: 'Model summary',
            attributes: { role: 'engineer' }
          }
        ]
      })
    );

    expect(hydrated[0]?.summary).toBe('Model summary');
    expect(hydrated[0]?.attributes).toEqual({
      mention_count: 1,
      role: 'engineer'
    });
  });

  test('merges alias arrays from baseline and model hydration', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { aliases: ['Ace'], mention_count: 1 }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: { aliases: ['Alicia', 'Ace'] }
          }
        ]
      })
    );

    expect(hydrated[0]?.attributes).toEqual({
      aliases: ['Ace', 'Alicia'],
      mention_count: 1
    });
  });

  test('merges configured string-set attributes across scalar and array forms', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          skills: ['python'],
          tags: 'founder'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              skills: ['typescript', 'python'],
              tags: ['operator', 'founder']
            }
          }
        ]
      })
    );

    expect(hydrated[0]?.attributes).toEqual({
      skills: ['python', 'typescript'],
      tags: ['founder', 'operator']
    });
  });

  test('merges configured team string-set attributes across scalar and array forms', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          teams: 'platform'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              teams: ['research', 'platform']
            }
          }
        ]
      })
    );

    expect(hydrated[0]?.attributes).toEqual({
      teams: ['platform', 'research']
    });
  });

  test('tracks history for changing string attributes while keeping the latest value', () => {
    const currentSeenAt = new Date('2026-03-30T12:00:00.000Z');
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { role: 'engineer', company: 'Acme' }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              role: 'manager',
              company: 'Acme'
            }
          }
        ]
      }),
      currentSeenAt
    );

    expect(hydrated[0]?.attributes).toEqual({
      role: 'manager',
      role_history: ['engineer', 'manager'],
      role_updated_at: '2026-03-30T12:00:00.000Z',
      company: 'Acme',
      company_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('tracks timestamped history for company transitions', () => {
    const currentSeenAt = new Date('2026-03-30T12:00:00.000Z');
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { company: 'Acme' }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              company: 'Globex'
            }
          }
        ]
      }),
      currentSeenAt
    );

    expect(hydrated[0]?.attributes).toEqual({
      company: 'Globex',
      company_history: ['Acme', 'Globex'],
      company_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('keeps the latest company when hydrating an older episode', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          company: 'Globex',
          last_seen_at: '2026-03-31T12:00:00.000Z'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              company: 'Acme'
            }
          }
        ]
      }),
      new Date('2026-03-29T12:00:00.000Z')
    );

    expect(hydrated[0]?.attributes).toEqual({
      company: 'Globex',
      company_history: ['Globex', 'Acme'],
      company_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('tracks timestamped history for department transitions', () => {
    const currentSeenAt = new Date('2026-03-30T12:00:00.000Z');
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { department: 'Engineering' }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              department: 'Research'
            }
          }
        ]
      }),
      currentSeenAt
    );

    expect(hydrated[0]?.attributes).toEqual({
      department: 'Research',
      department_history: ['Engineering', 'Research'],
      department_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('keeps the latest department when hydrating an older episode', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          department: 'Research',
          last_seen_at: '2026-03-31T12:00:00.000Z'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              department: 'Engineering'
            }
          }
        ]
      }),
      new Date('2026-03-29T12:00:00.000Z')
    );

    expect(hydrated[0]?.attributes).toEqual({
      department: 'Research',
      department_history: ['Research', 'Engineering'],
      department_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('tracks timestamped history for location transitions', () => {
    const currentSeenAt = new Date('2026-03-30T12:00:00.000Z');
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { location: 'New York' }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              location: 'San Francisco'
            }
          }
        ]
      }),
      currentSeenAt
    );

    expect(hydrated[0]?.attributes).toEqual({
      location: 'San Francisco',
      location_history: ['New York', 'San Francisco'],
      location_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('keeps the latest location when hydrating an older episode', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          location: 'San Francisco',
          last_seen_at: '2026-03-31T12:00:00.000Z'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              location: 'New York'
            }
          }
        ]
      }),
      new Date('2026-03-29T12:00:00.000Z')
    );

    expect(hydrated[0]?.attributes).toEqual({
      location: 'San Francisco',
      location_history: ['San Francisco', 'New York'],
      location_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('tracks timestamped history for title transitions', () => {
    const currentSeenAt = new Date('2026-03-30T12:00:00.000Z');
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { title: 'Engineer' }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              title: 'Director'
            }
          }
        ]
      }),
      currentSeenAt
    );

    expect(hydrated[0]?.attributes).toEqual({
      title: 'Director',
      title_history: ['Engineer', 'Director'],
      title_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('keeps the latest title when hydrating an older episode', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          title: 'Director',
          last_seen_at: '2026-03-31T12:00:00.000Z'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              title: 'Engineer'
            }
          }
        ]
      }),
      new Date('2026-03-29T12:00:00.000Z')
    );

    expect(hydrated[0]?.attributes).toEqual({
      title: 'Director',
      title_history: ['Director', 'Engineer'],
      title_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('tracks timestamped history for status transitions', () => {
    const currentSeenAt = new Date('2026-03-30T12:00:00.000Z');
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: { status: 'active' }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              status: 'inactive'
            }
          }
        ]
      }),
      currentSeenAt
    );

    expect(hydrated[0]?.attributes).toEqual({
      status: 'inactive',
      status_history: ['active', 'inactive'],
      status_updated_at: '2026-03-30T12:00:00.000Z'
    });
  });

  test('keeps the latest status when hydrating an older episode', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          status: 'inactive',
          last_seen_at: '2026-03-31T12:00:00.000Z'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              status: 'active'
            }
          }
        ]
      }),
      new Date('2026-03-29T12:00:00.000Z')
    );

    expect(hydrated[0]?.attributes).toEqual({
      status: 'inactive',
      status_history: ['inactive', 'active'],
      status_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('keeps the latest string attribute when hydrating an older episode', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          role: 'manager',
          last_seen_at: '2026-03-31T12:00:00.000Z'
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              role: 'engineer'
            }
          }
        ]
      }),
      new Date('2026-03-29T12:00:00.000Z')
    );

    expect(hydrated[0]?.attributes).toEqual({
      role: 'manager',
      role_history: ['manager', 'engineer'],
      role_updated_at: '2026-03-31T12:00:00.000Z',
      last_seen_at: '2026-03-31T12:00:00.000Z'
    });
  });

  test('ignores null model attributes so missing evidence does not erase maintained values', () => {
    const baseline = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: 'old summary',
        attributes: {
          role: 'manager',
          role_updated_at: '2026-03-31T12:00:00.000Z',
          skills: ['python'],
          mention_count: 3
        }
      }
    ];

    const hydrated = mapModelHydrationResponse(
      baseline,
      JSON.stringify({
        entities: [
          {
            uuid: 'entity-1',
            attributes: {
              role: null,
              skills: null,
              mention_count: null
            }
          }
        ]
      }),
      new Date('2026-03-30T12:00:00.000Z')
    );

    expect(hydrated[0]?.attributes).toEqual({
      role: 'manager',
      role_updated_at: '2026-03-31T12:00:00.000Z',
      skills: ['python'],
      mention_count: 3
    });
  });

  test('accepts fenced json hydration responses', () => {
    const parsed = parseModelHydrationResponse(
      '```json\n{"entities":[{"uuid":"entity-1","summary":"Model summary"}]}\n```'
    );

    expect(parsed.entities?.[0]?.uuid).toBe('entity-1');
  });

  test('uses the model hydrator and preserves heuristic defaults', async () => {
    const hydrator = new ModelNodeHydrator(new FakeHydrationLLMClient());
    const episode = {
      uuid: 'episode-2',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice knows Bob.',
      valid_at: utcNow(),
      entity_edges: []
    };
    const entities = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: ''
      }
    ];
    const edges = [
      {
        uuid: 'edge-1',
        group_id: 'group',
        source_node_uuid: 'entity-1',
        target_node_uuid: 'entity-2',
        created_at: utcNow(),
        name: 'knows',
        fact: 'Alice knows Bob',
        episodes: ['episode-2']
      }
    ];

    const hydrated = await hydrator.hydrate({
      episode,
      previous_episodes: [],
      entities,
      entity_edges: edges
    });

    expect(hydrated[0]?.summary).toBe('Alice is a trusted collaborator.');
    expect(hydrated[0]?.attributes?.source_description).toBe('chat');
    expect(hydrated[0]?.attributes?.role).toBe('engineer');
  });

  test('falls back to heuristic hydration when model output is invalid', async () => {
    const hydrator = new ModelNodeHydrator(new BrokenHydrationLLMClient());
    const episode = {
      uuid: 'episode-3',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice knows Bob.',
      valid_at: utcNow(),
      entity_edges: []
    };
    const entities = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: ''
      }
    ];

    const hydrated = await hydrator.hydrate({
      episode,
      previous_episodes: [],
      entities,
      entity_edges: []
    });

    expect(hydrated[0]?.summary).toContain('Alice knows Bob');
    expect(hydrated[0]?.attributes?.source_description).toBe('chat');
  });

  test('falls back to heuristic hydration when model output is parseable but invalid', async () => {
    const hydrator = new ModelNodeHydrator(new InvalidShapeHydrationLLMClient());
    const episode = {
      uuid: 'episode-3b',
      name: 'episode',
      group_id: 'group',
      labels: [],
      created_at: utcNow(),
      source: EpisodeTypes.text,
      source_description: 'chat',
      content: 'Alice knows Bob.',
      valid_at: utcNow(),
      entity_edges: []
    };
    const entities = [
      {
        uuid: 'entity-1',
        name: 'Alice',
        group_id: 'group',
        labels: ['Extracted'],
        created_at: utcNow(),
        summary: ''
      }
    ];

    const hydrated = await hydrator.hydrate({
      episode,
      previous_episodes: [],
      entities,
      entity_edges: []
    });

    expect(hydrated[0]?.summary).toContain('Alice knows Bob');
    expect(hydrated[0]?.attributes?.source_description).toBe('chat');
  });

  test('builds a structured hydration prompt with graph context', () => {
    const messages = buildNodeHydrationPrompt({
      episode: {
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
      },
      previous_episodes: [],
      entities: [
        {
          uuid: 'entity-1',
          name: 'Alice',
          group_id: 'group',
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        }
      ],
      entity_edges: []
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toContain('Alice knows Bob');
    expect(messages[1]?.content).toContain('entity-1');
  });
});

class FakeHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
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

class BrokenHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return 'not json';
  }
}

class InvalidShapeHydrationLLMClient {
  readonly model = 'fake-model';
  readonly small_model = null;

  setTracer(): void {}

  async generateText(): Promise<string> {
    return JSON.stringify({
      entities: [{ uuid: 'entity-1', attributes: 'not-an-object' }]
    });
  }
}
